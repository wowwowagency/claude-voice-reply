export type VoiceMode = 'auto' | 'manual'

declare module 'claude-code' {
  interface PluginState {
    'voice-reply': { mode: VoiceMode; lastLine: string }
  }
}
