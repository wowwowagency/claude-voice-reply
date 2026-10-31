# voice-reply for Claude Code

Claude ends every reply with one short spoken line that starts with 🔊. This plugin reads that
line aloud, while the full reply stays on screen.

- A **🔊 Speak** button under every reply.
- A switch above the prompt: **Voice: ● Auto ○ Manual · ▶ Replay · ■ Stop**. The lit segment is
  the mode in force. Auto speaks every reply as it lands; Manual waits for the button.
- The mode is per session and every new session starts in Manual, so several sessions running
  side by side don't talk over each other.
- Commands: `/voice-mode auto|manual` (no argument toggles), `/say` replays the last line,
  `/voice-stop` stops it.
- The instruction that makes Claude write the 🔊 line comes with the plugin; you don't edit
  your `CLAUDE.md`.

Works in the Claude desktop app (Code tab) and in the terminal, on Windows, macOS and Linux.
Nothing else to install: no Python, no ffmpeg.

## Install

**Desktop app:** click **+** next to the prompt box → **Plugins** → **Add marketplace** →
`wowwowagency/claude-voice-reply` → **Add plugin** → `voice-reply`.

**Terminal:** at the Claude Code prompt:

```
/plugin install voice-reply --marketplace wowwowagency/claude-voice-reply
```

or from a shell:

```
claude plugin install voice-reply --marketplace wowwowagency/claude-voice-reply
```

Answer `y` to add the marketplace and pick the user scope. Start a new session afterwards.

## The voice: Gemini (recommended) or your system voice

Without a key the plugin speaks with the voice your system already has (Windows: Microsoft
voices such as Irina for Russian, macOS: `say`). For a natural voice, give it a Gemini key:

1. Open [aistudio.google.com/apikey](https://aistudio.google.com/apikey) and create a key.
2. Give it to the plugin, any one of:
   - the **Gemini API key** field the install screen shows (kept in your system's secure storage);
   - the environment variable `GEMINI_API_KEY`;
   - a file `~/.claude/voice/gemini.key` holding just the key.

The free Gemini tier allows only a few speech requests a day; when it runs out the plugin
falls back to the system voice until the quota resets, so the voice may switch. For one steady
voice, turn on billing for the key's project in AI Studio — short spoken lines cost very little.

## Options

Set at install, or later in `/config` (terminal) under the plugin's name:

| Option | Default | What it does |
| --- | --- | --- |
| `gemini_api_key` | — | Your Gemini key (secret). |
| `gemini_voice` | `Achird` | Any Gemini TTS voice: Kore, Puck, Charon, Aoede, … |
| `gemini_model` | `gemini-3.8-flash-lite-tts` | The Gemini speech model. |
| `style` | calm, warm, conversational | How the voice should sound, in plain words. |
| `ui_language` | `en` | Buttons and messages in `en` or `ru`. |

## What it costs

- **Claude:** the 🔊 line is 30–60 output tokens per reply; the plugin adds one short paragraph
  to the system prompt. The buttons and commands never call the model.
- **Speed:** speech runs beside Claude; nothing waits for it.
- **Google:** only the lines you play, and only with a key. Without a key, nothing.

## Privacy

Only the 🔊 line is sent, and only to Google's Gemini API, and only when it is played with a key
set. Your key stays on your machine.

---

## По-русски

Claude заканчивает каждый ответ короткой строкой с 🔊 — плагин читает её вслух, текст остаётся
на экране. Кнопка «🔊 Озвучить» под ответом, переключатель «Голос: ● Авто ○ Вручную · ▶ Повторить ·
■ Стоп» над полем ввода; новая сессия стартует во «Вручную». Чтобы кнопки были на русском, поставьте
опцию `ui_language` = `ru`.

Установка в приложении: **+** у поля ввода → **Plugins** → **Add marketplace** →
`wowwowagency/claude-voice-reply` → **Add plugin**. Голос Google — ключ с
[aistudio.google.com/apikey](https://aistudio.google.com/apikey) в поле при установке, в переменной
`GEMINI_API_KEY` или в файле `~/.claude/voice/gemini.key`. Без ключа говорит системный голос.
