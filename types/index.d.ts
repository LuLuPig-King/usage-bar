export type UsageView = {
  windows: { kind: string; percentUsed: number; resetsAt?: string }[]
  session?: number
  today?: number
  month?: number
  now: number
}

declare module 'claude-code' {
  interface PluginState {
    'usage-bar': { view: UsageView | null }
  }
}
