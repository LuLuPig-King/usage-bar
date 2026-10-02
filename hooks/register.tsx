import type { EngineInterface, Register } from 'claude-code'

import type { UsageView } from '../types'

// Ledger and rate-limit cache live in the plugin's own $.store (kept across sessions, under the Claude Code config directory), so no absolute paths are used
const LEDGER_KEY = 'ledger'
// Last-seen 5h/7d windows: before the first reply of a new session the API has no data yet, so show the last values instead of all "--"
const WINDOWS_KEY = 'windows'
// Keep per-session baselines only this long, so the ledger cannot grow forever
const SESSION_KEEP_SECS = 40 * 86400

type Ledger = {
  sessions: Record<string, { cost: number; ts: number }>
  days: Record<string, number>
}

// Reference to the state value this plugin draws from (plugin and key must be literals)
const view = { plugin: 'usage-bar', key: 'view' } as const

const pad = (n: number) => String(n).padStart(2, '0')
const dayKey = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const money = (n?: number) =>
  n === undefined ? '--' : n >= 100 ? `$${Math.floor(n)}` : `$${n.toFixed(2)}`

// Time left until reset: 1h7m / 3d2h / 12m, without a "resets" prefix
const resetsIn = (resetsAt: string | undefined, now: number) => {
  if (!resetsAt) return ''
  const secs = Math.floor((Date.parse(resetsAt) - now) / 1000)
  if (secs <= 0) return 'soon'
  const days = Math.floor(secs / 86400)
  const hours = Math.floor((secs % 86400) / 3600)
  const mins = Math.floor((secs % 3600) / 60)
  return days > 0 ? `${days}d${hours}h` : hours > 0 ? `${hours}h${mins}m` : `${mins}m`
}

const GREEN = '#30A46C'
const AMBER = '#E0A21E'
const RED = '#E5484D'
const tone = (pct: number) => (pct >= 90 ? RED : pct >= 70 ? AMBER : GREEN)

const glyph = (kind: 'clock' | 'calendar' | 'dollar', c: string) => {
  const line = `fill="none" stroke="${c}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"`
  if (kind === 'clock') return `<path d="M13 8.5V13l3 1.8" ${line}/>`
  if (kind === 'calendar') return `<rect x="8.5" y="9.5" width="9" height="8" rx="1.6" ${line}/><path d="M8.5 12.5h9M11 8v3M15 8v3" ${line}/>`
  return `<text x="13" y="17.4" text-anchor="middle" font-size="12" font-weight="700" fill="${c}" font-family="ui-sans-serif,system-ui,sans-serif">$</text>`
}

// Ring: faint track + an arc drawn to the percentage, with a small icon in the middle
const ring = (pct: number, c: string, kind: 'clock' | 'calendar' | 'dollar') => {
  const r = 10
  const len = 2 * Math.PI * r
  const arc = (Math.min(100, Math.max(0, pct)) / 100) * len
  return `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26"><circle cx="13" cy="13" r="${r}" fill="none" stroke="${c}" stroke-opacity=".28" stroke-width="2.4"/><circle cx="13" cy="13" r="${r}" fill="none" stroke="${c}" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="${arc.toFixed(1)} ${len.toFixed(1)}" transform="rotate(-90 13 13)"/>${glyph(kind, c)}</svg>`
}

async function refresh($: EngineInterface) {
  const usage = await $.session.usage()
  const now = await $.clock.now()
  const sid = await $.session.id()
  const cost = usage.cost?.usd
  const today = dayKey(now)
  const month = today.slice(0, 7)

  const stored = (await $.store.get(LEDGER_KEY).catch(() => undefined)) as Ledger | undefined
  const ledger: Ledger = { sessions: stored?.sessions ?? {}, days: stored?.days ?? {} }

  if (cost !== undefined) {
    const last = ledger.sessions[sid]?.cost
    // First time this session is seen: count its full cost if it started under 10 minutes ago, otherwise treat it as an old session and only record a baseline
    const delta =
      last === undefined
        ? now - usage.startedAt < 600000 ? cost : 0
        : Math.max(0, cost - last)
    ledger.days[today] = (ledger.days[today] ?? 0) + delta
    ledger.sessions[sid] = { cost, ts: Math.floor(now / 1000) }
    for (const [id, x] of Object.entries(ledger.sessions)) {
      if (x.ts < now / 1000 - SESSION_KEEP_SECS) delete ledger.sessions[id]
    }
    await $.store.set(LEDGER_KEY, ledger).catch(() => undefined)
  }

  const monthTotal = Object.entries(ledger.days)
    .filter(([k]) => k.startsWith(month))
    .reduce((s, [, v]) => s + v, 0)

  let windows: UsageView['windows'] = usage.rateLimits
  if (windows.length > 0) {
    await $.store.set(WINDOWS_KEY, windows).catch(() => undefined)
  } else {
    const cached = (await $.store.get(WINDOWS_KEY).catch(() => undefined)) as UsageView['windows'] | undefined
    windows = (cached ?? []).filter(w => !w.resetsAt || Date.parse(w.resetsAt) > now)
  }

  const next: UsageView = {
    windows,
    session: cost,
    today: ledger.days[today],
    month: monthTotal,
    now,
  }
  await $.state.set(view, next)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await refresh($)
    // Refresh every minute so the countdown keeps moving
    $.clock.every(60000, () => {
      void refresh($)
    })
    return result
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    await refresh($)
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { value: v = null } = await $.state.get(view)
    if (e.props.hasSurvey || v === null) return next(e)

    const t = $.ui.resolve(e)
    const { Box, Text } = t
    const Svg = 'Svg' in t ? t.Svg : null
    // Other mods may draw in this same spot (e.g. a progress bar): get what they draw first
    const below = await next(e)
    // next(e) can return an empty shell when nothing below draws; only real text/image/button content counts, otherwise the card gets a blank row under it
    const hasBelow = below != null && /"type":"(Text|Svg|Button|Input|Markdown|Image|Raster)"/.test(JSON.stringify(below))

    // The desktop app already wraps this spot in a rounded card with padding, so draw no background or vertical padding here, otherwise it is a frame inside a frame
    // One group: ring icon + main number (white, bold) + dim description; nothing may shrink, or text wraps onto two lines when narrow
    const item = (kind: 'clock' | 'calendar' | 'dollar', pct: number, ringColor: string, main: string, parts: string[], mainColor?: string) => (
      <Box flexDirection="row" alignItems="center" gap={1} flexShrink={0}>
        {Svg ? <Svg source={ring(pct, ringColor, kind)} alt={`${kind} ${Math.round(pct)}%`} width={23} height={23} /> : null}
        <Box flexShrink={0}>
          <Text bold color={mainColor}>{main}</Text>
        </Box>
        {parts.map(x => (
          <Box key={x} flexShrink={0}>
            <Text dimColor>{x}</Text>
          </Box>
        ))}
      </Box>
    )
    const win = (kind: string, icon: 'clock' | 'calendar', label: string) => {
      const w = v.windows.find(x => x.kind === kind)
      if (!w) return item(icon, 0, GREEN, '--', [label])
      const pct = Math.round(w.percentUsed)
      const left = resetsIn(w.resetsAt, v.now)
      return item(icon, pct, tone(pct), `${pct}%`, [left ? `${label} · ${left}` : label])
    }

    // Shrink to the card's actual width (e.props.bodyColumns, about 9.5px per column on desktop): everything needs about 61 columns; when narrower drop mo, then today, and finally keep only 5h and 7d
    const cols = e.props.bodyColumns
    const costParts = cols >= 64 ? [`${money(v.today)} today`, `${money(v.month)} mo`] : cols >= 56 ? [`${money(v.today)} today`] : []
    const row = (
      <Box flexDirection="row" alignItems="center" gap={4} paddingX={1}>
        {win('five_hour', 'clock', '5h')}
        {win('seven_day', 'calendar', '7d')}
        {cols >= 48 ? item('dollar', 100, GREEN, money(v.session), costParts, GREEN) : null}
      </Box>
    )
    if (!hasBelow) return row

    return (
      <Box flexDirection="column" gap={1}>
        {row}
        {below}
      </Box>
    )
  })
}
