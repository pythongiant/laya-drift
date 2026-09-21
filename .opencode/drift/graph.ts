import type { DriftHistoryEntry } from "./types"

export type GraphPoint = {
  at: number
  score: number
  delta?: number
  top?: string
  trigger?: string
  label?: string
}

const HEIGHT = 8
const MAX_COLS = 72
const SPARK = "▁▂▃▄▅▆▇█"

export function downsamplePoints(points: GraphPoint[], max: number): GraphPoint[] {
  if (points.length <= max) return points
  const bucket = Math.ceil(points.length / max)
  const out: GraphPoint[] = []
  for (let i = 0; i < points.length; i += bucket) {
    const slice = points.slice(i, i + bucket)
    const avg = slice.reduce((sum, point) => sum + point.score, 0) / slice.length
    const peak = slice.reduce((best, point) => (point.score > best.score ? point : best), slice[0]!)
    out.push({ ...peak, score: Math.round(avg * 10) / 10 })
  }
  return out
}

function level(score: number): number {
  return Math.max(score > 0 ? 1 : 0, Math.ceil((score / 100) * HEIGHT))
}

export function renderGraph(points: GraphPoint[], title: string, caption?: string): string {
  if (!points.length) {
    return `${title}\n\nNo drift history yet. Run /calibrate and work for a few turns.`
  }

  const cols = downsamplePoints(points, MAX_COLS)
  const lines: string[] = [title, ""]

  for (let row = HEIGHT; row >= 1; row -= 1) {
    const label = row % 2 === 0 ? String(Math.round((row / HEIGHT) * 100)).padStart(3) : "   "
    const cells = cols.map((point) => (level(point.score) >= row ? "█" : " "))
    lines.push(`${label} ┤${cells.join("")}`)
  }

  lines.push(`  0 ┼${"─".repeat(cols.length)}`)

  const spark = points
    .map((point) => SPARK[Math.min(SPARK.length - 1, Math.floor(point.score / 12.5))])
    .join("")
  lines.push(`    ${spark}`)

  const scores = points.map((point) => point.score)
  const peak = points.reduce((best, point) => (point.score > best.score ? point : best), points[0]!)
  const low = Math.min(...scores)
  const avg = scores.reduce((sum, score) => sum + score, 0) / scores.length
  const first = points[0]!
  const last = points[points.length - 1]!
  const spanMinutes = Math.max(0, Math.round((last.at - first.at) / 60000))
  const trend = last.score - first.score

  lines.push(
    "",
    `turns ${points.length} · current ${last.score.toFixed(1)} · peak ${peak.score.toFixed(1)} · low ${low.toFixed(1)} · avg ${avg.toFixed(1)} · trend ${trend >= 0 ? "▲" : "▼"}${Math.abs(trend).toFixed(1)} · span ${spanMinutes}m`,
    `bands: <20 on-plan · <40 slight · <65 drifting · ≥65 off-plan`,
  )

  const recent = points.slice(-6).reverse()
  lines.push(
    "",
    "recent:",
    ...recent.map((point, index) => {
      const turn = points.length - index
      const when = new Date(point.at).toISOString().slice(11, 16)
      const label = point.label ? `${point.label} ` : ""
      const top = point.top ? ` · ${point.top}` : ""
      const trigger = point.trigger ? ` · ${point.trigger}` : ""
      return `  #${String(turn).padStart(3)} ${when} ${label}${point.score.toFixed(1)}${top}${trigger}`
    }),
  )

  if (caption) lines.push("", caption)
  return lines.join("\n")
}

export function historyPoints(history: DriftHistoryEntry[], label?: string): GraphPoint[] {
  return history.map((entry) => ({
    at: entry.at,
    score: entry.score,
    delta: entry.delta,
    top: entry.top,
    trigger: entry.trigger,
    label,
  }))
}
