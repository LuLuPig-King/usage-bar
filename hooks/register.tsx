import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { UsageView } from '../types'

// 账本和额度缓存都放在插件自己的 $.store(跨会话保存, 位于用户的 Claude Code 配置目录下), 不碰任何绝对路径
const LEDGER_KEY = 'ledger'
// 上次读到的 5h/7d 额度: 新会话第一次回复前接口还没数据, 先显示上次的值, 免得一片 --
const WINDOWS_KEY = 'windows'
// 账本只保留最近这么久的会话基线, 防止无限增长
const SESSION_KEEP_SECS = 40 * 86400

type Ledger = {
  sessions: Record<string, { cost: number; ts: number }>
  days: Record<string, number>
}

const view = atom({ plugin: 'usage-bar', key: 'view' } as const, null)

const pad = (n: number) => String(n).padStart(2, '0')
const dayKey = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const money = (n?: number) =>
  n === undefined ? '--' : n >= 100 ? `$${Math.floor(n)}` : `$${n.toFixed(2)}`

// 距离重置的剩余时间: 1h7m / 3d2h / 12m, 不带 "resets" 字样
const resetsIn = (resetsAt: string | undefined, now: number) => {
  if (!resetsAt) return ''
  const secs = Math.floor((Date.parse(resetsAt) - now) / 1000)
  if (secs <= 0) return 'soon'
  const d = Math.floor(secs / 86400)
  const h = Math.floor((secs % 86400) / 3600)
  const m = Math.floor((secs % 3600) / 60)
  return d > 0 ? `${d}d${h}h` : h > 0 ? `${h}h${m}m` : `${m}m`
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

// 圆环: 浅色底圈 + 按百分比绘制的弧, 中间一个小图标
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
    // 首次见到的会话: 开始不到 10 分钟按全额计入, 否则视为老会话只记基线
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
  await update($, view, () => next)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await refresh($)
    // 每分钟刷新一次, 让倒计时走动
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
    const v = await read($, view)
    if (e.props.hasSurvey || v === null) return next(e)

    const t = $.ui.resolve(e)
    const { Box, Text } = t
    const Svg = 'Svg' in t ? t.Svg : null
    // 同一位置还有别的 mod(如 plan-progress 进度条): 先拿到它们画的内容
    const below = await next(e)
    // next(e) 没人画时也可能返回一个空壳, 只有里面真有文字/图/按钮才算有内容, 否则卡片下面会多出一行空白
    const hasBelow = below != null && /"type":"(Text|Svg|Button|Input|Markdown|Image|Raster)"/.test(JSON.stringify(below))

    // 桌面版已经给这个位置套了圆角卡片和内边距, 这里不再画背景和上下边距, 否则就是框里套框
    // 一组: 圆环图标 + 主数字(白色加粗) + 淡色说明; 所有部分禁止收缩, 否则窄的时候文字会被挤成两行
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

    // 按卡片实际宽度(e.props.bodyColumns, 桌面版实测约 9.5px 一列)收缩: 全部约 61 列, 窄了先去掉 mo, 再去掉 today, 最后只留 5h 和 7d
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
