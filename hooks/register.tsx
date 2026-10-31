import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { VoiceMode } from '../types'

// Each reply ends with a line led by the speaker emoji; only that line is spoken.
const MARKER = '\u{1F50A}'
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta'
// Across sessions: after a 429 the key is skipped until Google's quota resets.
const BLOCK_KEY = 'geminiBlockedUntil'
const PLAY_TIMEOUT = 600_000

const VOICE_PROMPT = `# Spoken summary line
End every reply to the user with one separate final line that starts with ${MARKER}. A button plays only that line aloud; the rest of the reply stays on screen and is not read. Write it as a colleague's quick spoken remark, not a recap of the report: one to three short sentences in the language of the conversation, conversational, saying what was done or found and what is needed from the user, if anything; when you are waiting for their decision, ask the question aloud. No paths, code, links, lists, markdown or strings of numbers: only what is worth hearing.`

const TEXT = {
  en: {
    voice: 'Voice:', auto: 'Auto', manual: 'Manual', replay: '▶ Replay', stop: '■ Stop', say: `${MARKER} Speak`,
    autoOn: 'Voice: auto. Every reply in this session is spoken by itself.',
    manualOn: `Voice: manual. Press ${MARKER} under a reply to hear it.`,
    nothing: 'Nothing to speak yet.', speaking: 'Speaking the last reply.',
    modeDescription: 'Voice in this session: auto, manual, or no argument to toggle',
    sayDescription: 'Speak the last reply again', stopDescription: 'Stop the voice',
    failed: 'Voice failed',
  },
  ru: {
    voice: 'Голос:', auto: 'Авто', manual: 'Вручную', replay: '▶ Повторить', stop: '■ Стоп', say: `${MARKER} Озвучить`,
    autoOn: 'Голос: авто — в этой сессии каждый ответ озвучивается сам.',
    manualOn: `Голос: вручную — нажимай ${MARKER} под ответом.`,
    nothing: 'Пока нечего озвучивать.', speaking: 'Озвучиваю последний ответ.',
    modeDescription: 'Голос в этой сессии: auto, manual или без аргумента — переключить',
    sayDescription: 'Озвучить последний ответ ещё раз', stopDescription: 'Остановить озвучку',
    failed: 'Голос: ошибка',
  },
}

// Per session: a new session starts in manual, so sessions running in parallel
// stay quiet unless the person switched that one to auto.
const mode = atom({ plugin: 'voice-reply', key: 'mode' } as const, 'manual' as VoiceMode)
const lastLine = atom({ plugin: 'voice-reply', key: 'lastLine' } as const, '')

function voiceLine(text: string): string {
  for (const raw of text.split('\n').reverse()) {
    const line = raw.trim().replace(/^>\s*/, '')
    if (line.startsWith(MARKER)) return line.slice(MARKER.length).trim()
  }
  return ''
}

function cleanForSpeech(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`#>|]/g, '')
    .replace(/^[\s:—–-]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// --- base64 and UTF-8 by hand: the module has no DOM and no Node.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let o = 0
  for (let i = 0; i < clean.length; i += 4) {
    const n =
      (B64.indexOf(clean.charAt(i)) << 18) |
      (B64.indexOf(clean.charAt(i + 1)) << 12) |
      ((B64.indexOf(clean.charAt(i + 2)) & 63) << 6) |
      (B64.indexOf(clean.charAt(i + 3)) & 63)
    if (o < out.length) out[o++] = (n >> 16) & 255
    if (o < out.length && i + 2 < clean.length) out[o++] = (n >> 8) & 255
    if (o < out.length && i + 3 < clean.length) out[o++] = n & 255
  }
  return out.subarray(0, o)
}

function toBase64(bytes: Uint8Array): string {
  const parts: string[] = []
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    const n = (a << 16) | (b << 8) | c
    parts.push(
      B64.charAt((n >> 18) & 63) +
        B64.charAt((n >> 12) & 63) +
        (i + 1 < bytes.length ? B64.charAt((n >> 6) & 63) : '=') +
        (i + 2 < bytes.length ? B64.charAt(n & 63) : '='),
    )
  }
  return parts.join('')
}

function utf8(s: string): Uint8Array {
  const out: number[] = []
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return new Uint8Array(out)
}

// Gemini answers headerless 16-bit mono PCM at 24 kHz; players want a WAV.
function pcmToWav(pcm: Uint8Array, rate = 24000): Uint8Array {
  const wav = new Uint8Array(44 + pcm.length)
  const v = new DataView(wav.buffer)
  const ascii = (at: number, s: string) => [...s].forEach((ch, i) => v.setUint8(at + i, ch.charCodeAt(0)))
  ascii(0, 'RIFF')
  v.setUint32(4, 36 + pcm.length, true)
  ascii(8, 'WAVEfmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  ascii(36, 'data')
  v.setUint32(40, pcm.length, true)
  wav.set(pcm, 44)
  return wav
}

function findAudio(node: unknown): string | undefined {
  if (Array.isArray(node)) {
    for (const v of node) {
      const found = findAudio(v)
      if (found) return found
    }
  } else if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>
    const mime = String(o.mime_type ?? o.mimeType ?? '')
    if (typeof o.data === 'string' && o.data.length > 100 && (!mime || mime.startsWith('audio'))) return o.data
    for (const v of Object.values(o)) {
      const found = findAudio(v)
      if (found) return found
    }
  }
  return undefined
}

// --- platform

type Platform = 'windows' | 'mac' | 'linux'
let platform: Platform | undefined

async function getPlatform($: EngineInterface): Promise<Platform> {
  if (platform) return platform
  if ((await $.env.get('OS')) === 'Windows_NT') return (platform = 'windows')
  const { stdout } = await $.process.run(['uname', '-s']).catch(() => ({ stdout: '' }))
  return (platform = stdout.trim() === 'Darwin' ? 'mac' : 'linux')
}

const PS = ['powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']
// The player writes its PID here, so Stop and the next line can end it.
const PS_PID = "$pf=Join-Path ([IO.Path]::GetTempPath()) 'voice-reply.pid'; Set-Content -LiteralPath $pf -Value $PID;"
const PS_PLAY =
  PS_PID +
  "$f=Join-Path ([IO.Path]::GetTempPath()) ('voice-reply-'+$PID+'.wav');" +
  '[IO.File]::WriteAllBytes($f,[Convert]::FromBase64String([Console]::In.ReadToEnd()));' +
  'try{(New-Object Media.SoundPlayer $f).PlaySync()}finally{Remove-Item -LiteralPath $f -ErrorAction SilentlyContinue}'
const PS_SPEAK =
  PS_PID +
  'Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer;' +
  '$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()));' +
  "if($t -match '[\\u0400-\\u04FF]'){$v=$s.GetInstalledVoices()|Where-Object{$_.VoiceInfo.Culture.Name -like 'ru*'}|Select-Object -First 1; if($v){$s.SelectVoice($v.VoiceInfo.Name)}};" +
  '$s.Speak($t)'
const PS_STOP =
  "$pf=Join-Path ([IO.Path]::GetTempPath()) 'voice-reply.pid'; if(Test-Path $pf){" +
  "Get-Process -Id (Get-Content $pf) -ErrorAction SilentlyContinue|Where-Object ProcessName -eq 'powershell'|Stop-Process -Force; Remove-Item $pf -ErrorAction SilentlyContinue}"
const SH_PLAY =
  'd="${TMPDIR:-/tmp}"; find "$d" -name "voice-reply-*.wav" -mmin +10 -delete 2>/dev/null; f="$d/voice-reply-$$.wav";' +
  'if base64 -d </dev/null >/dev/null 2>&1; then base64 -d > "$f"; else base64 -D > "$f"; fi;' +
  'echo $$ > "$d/voice-reply.pid";' +
  'if command -v afplay >/dev/null; then exec afplay "$f"; elif command -v paplay >/dev/null; then exec paplay "$f"; else exec aplay -q "$f"; fi'
const SH_STOP = 'p="${TMPDIR:-/tmp}/voice-reply.pid"; [ -f "$p" ] && kill "$(cat "$p")" 2>/dev/null; rm -f "$p"'

async function stopPlayback($: EngineInterface) {
  const argv = (await getPlatform($)) === 'windows' ? [...PS, PS_STOP] : ['sh', '-c', SH_STOP]
  await $.process.run(argv).catch(() => undefined)
}

async function playWav($: EngineInterface, wav: Uint8Array) {
  await stopPlayback($)
  const argv = (await getPlatform($)) === 'windows' ? [...PS, PS_PLAY] : ['sh', '-c', SH_PLAY]
  await $.process.run(argv, { stdin: toBase64(wav), timeoutMs: PLAY_TIMEOUT })
}

async function speakWithSystem($: EngineInterface, text: string) {
  await stopPlayback($)
  if ((await getPlatform($)) === 'windows') {
    await $.process.run([...PS, PS_SPEAK], { stdin: toBase64(utf8(text)), timeoutMs: PLAY_TIMEOUT })
    return
  }
  const voice = /[Ѐ-ӿ]/.test(text) ? 'Milena' : undefined
  await $.audio.speak(text, voice ? { voice } : undefined).catch(() => $.audio.speak(text))
}

// --- Gemini

async function geminiKey($: EngineInterface, configured: string): Promise<string> {
  if (configured.trim()) return configured.trim()
  const fromEnv = (await $.env.get('GEMINI_API_KEY')) ?? ''
  if (fromEnv.trim()) return fromEnv.trim()
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''
  if (!home) return ''
  const text = await $.fs.read(`${home}/.claude/voice/gemini.key`).catch(() => '')
  return text.replace(/^﻿/, '').trim()
}

async function noteRateLimit($: EngineInterface, body: string) {
  const m = /retry in (?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/.exec(body)
  let wait = 3600
  if (m && (m[1] || m[2] || m[3])) wait = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)
  await $.store.set(BLOCK_KEY, Date.now() + wait * 1000)
}

type Voice = { key: string; voice: string; model: string; style: string }

async function synthGemini($: EngineInterface, text: string, v: Voice): Promise<Uint8Array | undefined> {
  if (!v.key) return undefined
  if (Number((await $.store.get(BLOCK_KEY)) ?? 0) > Date.now()) return undefined
  const headers = { 'x-goog-api-key': v.key, 'Content-Type': 'application/json' }
  const routes = [
    {
      url: `${GEMINI}/interactions`,
      body: {
        model: v.model,
        input: [{
          type: 'user_input',
          content: [{ type: 'text', text, annotations: v.style ? [{ type: 'speech_metadata', style: v.style }] : [] }],
        }],
        generation_config: { speech_config: [{ voice: v.voice }] },
      },
    },
    // The older generateContent shape, in case the model answers only there.
    {
      url: `${GEMINI}/models/${v.model}:generateContent`,
      body: {
        contents: [{ parts: [{ text: (v.style ? `Say in a ${v.style} tone: ` : '') + text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: v.voice } } },
        },
      },
    },
  ]
  for (const route of routes) {
    const res = await $.http
      .fetch(route.url, { method: 'POST', headers, body: JSON.stringify(route.body) })
      .catch(() => undefined)
    if (!res) continue
    if (res.status === 429) {
      await noteRateLimit($, res.text)
      return undefined // the other route shares the quota
    }
    if (!res.ok) continue
    let data: string | undefined
    try {
      data = findAudio(JSON.parse(res.text))
    } catch {
      data = undefined
    }
    if (!data) continue
    const audio = fromBase64(data)
    const riff = audio[0] === 0x52 && audio[1] === 0x49 && audio[2] === 0x46 && audio[3] === 0x46
    return riff ? audio : pcmToWav(audio)
  }
  return undefined
}

// Set from the options each time the module registers.
let t = TEXT.en
let configuredKey = ''
let voice = { voice: 'Achird', model: 'gemini-3.8-flash-lite-tts', style: '' }

async function speak($: EngineInterface, line: string) {
  const text = cleanForSpeech(line)
  if (!text) return
  const wav = await synthGemini($, text, { ...voice, key: await geminiKey($, configuredKey) })
  if (wav) await playWav($, wav)
  else await speakWithSystem($, text)
}

function say($: EngineInterface, line: string) {
  void speak($, line).catch(err => $.ui.toast(`${t.failed}: ${String(err).slice(0, 200)}`))
}

function stop($: EngineInterface) {
  void stopPlayback($)
}

async function setMode($: EngineInterface, next: VoiceMode) {
  await update($, mode, () => next)
  return next === 'auto' ? t.autoOn : t.manualOn
}

export const register: Register = (on, options) => {
  t = TEXT[options.ui_language === 'ru' ? 'ru' : 'en']
  configuredKey = typeof options.gemini_api_key === 'string' ? options.gemini_api_key : ''
  voice = {
    voice: String(options.gemini_voice || 'Achird'),
    model: String(options.gemini_model || 'gemini-3.8-flash-lite-tts'),
    style: String(options.style ?? ''),
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'voice-mode', description: t.modeDescription, argumentHint: '[auto|manual]' })
    await $.command.register({ name: 'say', description: t.sayDescription })
    await $.command.register({ name: 'voice-stop', description: t.stopDescription })

    return next(e)
  })

  // The instruction that makes Claude write the line, so nobody edits CLAUDE.md.
  on('prompt.compose', async ($, e, next) => {
    const { sections } = await next(e)
    return { sections: [...sections, { id: 'voice-reply:line', text: VOICE_PROMPT, scope: 'session' as const }] }
  })

  on('command.run', { command: 'voice-mode' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const current = await read($, mode)
    const wanted: VoiceMode =
      arg === 'auto' || arg === 'авто'
        ? 'auto'
        : arg === 'manual' || arg === 'вручную'
          ? 'manual'
          : current === 'auto'
            ? 'manual'
            : 'auto'

    return { text: await setMode($, wanted) }
  })

  on('command.run', { command: 'say' }, async $ => {
    const line = await read($, lastLine)
    if (!line) return { text: t.nothing }
    say($, line)

    return { text: t.speaking }
  })

  on('command.run', { command: 'voice-stop' }, async $ => {
    stop($)

    return { text: t.stop }
  })

  // The main loop's answers only: a subagent's report is no reply to the person.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && e.reason === 'answer') {
      const line = voiceLine(e.answer)
      if (line) {
        await update($, lastLine, () => line)
        if ((await read($, mode)) === 'auto') say($, line)
      }
    }

    return next(e)
  })

  // A speaker button under the block that carries the voice line.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const line = voiceLine(e.props.text)
    if (!line) return next(e)

    const own = await next(e)
    const { Box, Button } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {own}
        <Box>
          <Button key="say" label={t.say} onPress={() => say($, line)} />
        </Box>
      </Box>
    )
  })

  // The switch, one row above the prompt: two segments, the current mode lit
  // and dotted, the other dim; pressing a segment selects that mode.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const current = await read($, mode)
    const last = await read($, lastLine)
    const { Box, Button, Text } = $.ui.resolve(e)
    const segment = (value: VoiceMode, name: string) =>
      current === value ? (
        <Button key={value} label={`● ${name}`} variant="primary" onPress={() => {}} />
      ) : (
        <Button key={value} label={`○ ${name}`} variant="secondary" dimColor onPress={() => setMode($, value)} />
      )

    return (
      <Box flexDirection="row" gap={1} alignItems="center">
        <Text dimColor>{t.voice}</Text>
        {segment('auto', t.auto)}
        {segment('manual', t.manual)}
        <Text dimColor>·</Text>
        {last !== '' && <Button key="replay" label={t.replay} onPress={() => say($, last)} />}
        <Button key="stop" label={t.stop} onPress={() => stop($)} />
      </Box>
    )
  })
}
