/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createSignal, onCleanup } from "solid-js"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { bandFor } from "../drift/embed"
import { downsamplePoints, type GraphPoint } from "../drift/graph"

const POLL_MS = 800
const CHART_HEIGHT = 9

type Band = "on-plan" | "slight" | "drifting" | "off-plan" | "unknown"

type Snapshot = {
  score: number
  band: Band
  delta: number
  top: string
  updatedAt: number
}

type HistoryEntry = { at: number; score: number; delta?: number; top?: string; trigger?: string }

type Detail = {
  score: number
  band: Band
  history: HistoryEntry[]
  warn: number
  alert: number
}

type Cell = { ch: string; band: Band }

function expandHome(path: string): string {
  if (path === "~") return homedir()
  if (path.startsWith("~/")) return join(homedir(), path.slice(2))
  return path
}

type Display = { stateDir: string; warn: number; alert: number }

let cachedDisplay: Display | null = null

function displayConfig(api: TuiPluginApi): Display {
  if (cachedDisplay) return cachedDisplay
  let stateDir = join(homedir(), ".local", "share", "laya-drift")
  let warn = 35
  let alert = 65
  try {
    const file = join(api.state.path.directory, ".opencode", "drift.json")
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, "utf8")) as {
        stateDir?: string
        display?: { warnThreshold?: number; alertThreshold?: number }
      }
      if (raw.stateDir) stateDir = expandHome(raw.stateDir)
      if (typeof raw.display?.warnThreshold === "number") warn = raw.display.warnThreshold
      if (typeof raw.display?.alertThreshold === "number") alert = raw.display.alertThreshold
    }
  } catch {
    // defaults
  }
  cachedDisplay = { stateDir, warn, alert }
  return cachedDisplay
}

function stateFile(stateDir: string, sessionID: string): string {
  return join(stateDir, "sessions", `${sessionID.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`)
}

function readSnapshot(display: Display, sessionID: string): Snapshot | null {
  try {
    const file = stateFile(display.stateDir, sessionID)
    if (!existsSync(file)) return null
    const raw = JSON.parse(readFileSync(file, "utf8")) as {
      score?: number
      band?: Band
      top?: string
      updatedAt?: number
      history?: HistoryEntry[]
    }
    if (typeof raw.score !== "number") return null
    const last = raw.history?.[raw.history.length - 1]
    return {
      score: raw.score,
      band: raw.band ?? "unknown",
      delta: last?.delta ?? 0,
      top: raw.top ?? "",
      updatedAt: raw.updatedAt ?? 0,
    }
  } catch {
    return null
  }
}

function readDetail(display: Display, sessionID: string): Detail | null {
  const snapshot = readSnapshot(display, sessionID)
  if (!snapshot) return null
  let history: HistoryEntry[] = []
  try {
    const raw = JSON.parse(readFileSync(stateFile(display.stateDir, sessionID), "utf8")) as { history?: HistoryEntry[] }
    history = Array.isArray(raw.history) ? raw.history : []
  } catch {
    history = []
  }
  return { ...snapshot, history, warn: display.warn, alert: display.alert }
}

const GLYPH: Record<Band, string> = {
  "on-plan": "●",
  slight: "◐",
  drifting: "◑",
  "off-plan": "○",
  unknown: "·",
}

const BAND_LABEL: Record<Band, string> = {
  "on-plan": "on plan",
  slight: "slight",
  drifting: "drifting",
  "off-plan": "off plan",
  unknown: "uncalibrated",
}

function scoreColor(api: TuiPluginApi, snapshot: { score: number } | null) {
  const theme = api.theme.current
  if (!snapshot) return theme.textMuted
  return snapshot.score < 50 ? theme.success : theme.error
}

function bandColor(api: TuiPluginApi, band: Band) {
  const theme = api.theme.current
  switch (band) {
    case "on-plan":
      return theme.success
    case "slight":
    case "drifting":
      return theme.warning
    case "off-plan":
      return theme.error
    default:
      return theme.textMuted
  }
}

function deltaLabel(delta: number): string {
  if (delta > 0.5) return ` ▲${delta.toFixed(0)}`
  if (delta < -0.5) return ` ▼${Math.abs(delta).toFixed(0)}`
  return ""
}

/** Polls the session drift state; keeps the TUI in sync after every turn. */
function useDrift(api: TuiPluginApi, sessionID: () => string | undefined) {
  const [snapshot, setSnapshot] = createSignal<Snapshot | null>(null)
  const timer = setInterval(() => {
    const id = sessionID()
    if (!id) return
    setSnapshot(readSnapshot(displayConfig(api), id))
  }, POLL_MS)
  onCleanup(() => clearInterval(timer))
  return snapshot
}

function resample(points: GraphPoint[], target: number): GraphPoint[] {
  if (points.length === 0) return []
  if (points.length >= target) return downsamplePoints(points, target)
  if (points.length === 1) return Array.from({ length: target }, () => points[0]!)
  const out: GraphPoint[] = []
  for (let i = 0; i < target; i += 1) {
    const t = (i / (target - 1)) * (points.length - 1)
    const lo = Math.floor(t)
    const hi = Math.min(points.length - 1, lo + 1)
    const f = t - lo
    out.push({ ...points[lo]!, score: points[lo]!.score * (1 - f) + points[hi]!.score * f })
  }
  return out
}

function buildChart(points: GraphPoint[], width: number, height: number, limit: number) {
  const peak = points.reduce((best, point) => Math.max(best, point.score), 0)
  const yMax = [25, 50, 75, 100].find((step) => peak <= step) ?? 100
  const cols = resample(points, width)
  const rows: Cell[][] = Array.from({ length: height }, () =>
    Array.from({ length: cols.length }, () => ({ ch: " ", band: "unknown" as Band })),
  )
  for (let x = 0; x < cols.length; x += 1) {
    const score = cols[x]!.score
    const band = bandFor(score) as Band
    const level = Math.max(1, Math.min(height, Math.ceil((score / yMax) * height)))
    for (let r = 0; r < level - 1; r += 1) {
      rows[r]![x] = { ch: "░", band: "unknown" }
    }
    rows[level - 1]![x] = { ch: "█", band }
  }
  const limitRow = Math.max(
    0,
    Math.min(height - 1, Math.round((Math.min(limit, yMax) / yMax) * (height - 1))),
  )
  if (limit <= yMax) {
    for (let x = 0; x < cols.length; x += 1) {
      if (rows[limitRow]![x]!.ch === " ") rows[limitRow]![x] = { ch: "┄", band: "unknown" }
    }
  }
  // Fixed-width label row: numbers are right-aligned to their tick column and
  // map back to real turn numbers, not column positions.
  const turns = points.length
  const turnAt = (x: number) =>
    Math.min(turns, Math.round((x / Math.max(1, cols.length - 1)) * (turns - 1)) + 1)
  const axis = Array.from({ length: cols.length }, () => " ")
  const ticks = new Set<number>([0, cols.length - 1])
  for (let x = 9; x < cols.length - 1; x += 10) ticks.add(x)
  for (const x of ticks) {
    const value = String(turnAt(x))
    const start = Math.max(0, x - (value.length - 1))
    for (let k = 0; k < value.length && start + k < axis.length; k += 1) axis[start + k] = value[k]!
  }
  return { rows, limitRow, labels: axis.join(""), count: cols.length, yMax, turns }
}

function Row(props: { api: TuiPluginApi; cells: Cell[]; label: string }) {
  const runs = () => {
    const out: Array<{ text: string; band: Band }> = []
    for (const cell of props.cells) {
      const last = out[out.length - 1]
      if (last && last.band === cell.band) last.text += cell.ch
      else out.push({ text: cell.ch, band: cell.band })
    }
    return out
  }
  return (
    <box flexDirection="row">
      <text fg={props.api.theme.current.textMuted}>{props.label}</text>
      <text>
        {runs().map((run) => (
          <span style={{ fg: bandColor(props.api, run.band) }}>{run.text}</span>
        ))}
      </text>
    </box>
  )
}

function DriftGraphDialog(props: { api: TuiPluginApi; onClose: () => void }) {
  const sessionID = () => {
    const route = props.api.route.current
    if (route.name !== "session") return undefined
    return (route.params as { sessionID?: string } | undefined)?.sessionID
  }

  const initial = (() => {
    const id = sessionID()
    return id ? readDetail(displayConfig(props.api), id) : null
  })()
  const [detail, setDetail] = createSignal<Detail | null>(initial)

  const timer = setInterval(() => {
    const id = sessionID()
    if (!id) return
    setDetail(readDetail(displayConfig(props.api), id))
  }, POLL_MS)
  onCleanup(() => clearInterval(timer))

  const width = () =>
    Math.max(40, Math.min(56, ((props.api.renderer as unknown as { width?: number }).width ?? 120) - 60))

  const chart = () => {
    const data = detail()
    if (!data || data.history.length === 0) return null
    return buildChart(
      data.history.map((entry) => ({ at: entry.at, score: entry.score, top: entry.top, trigger: entry.trigger })),
      width(),
      CHART_HEIGHT,
      data.alert,
    )
  }

  const peak = () => {
    const data = detail()
    if (!data || data.history.length === 0) return null
    return data.history.reduce(
      (best, entry, index) => (entry.score > best.score ? { score: entry.score, index } : best),
      { score: data.history[0]!.score, index: 0 },
    )
  }

  const average = () => {
    const data = detail()
    if (!data || data.history.length === 0) return 0
    return data.history.reduce((sum, entry) => sum + entry.score, 0) / data.history.length
  }

  return (
    <box
      flexDirection="column"
      paddingTop={(() => {
        const rows = (props.api.renderer as unknown as { height?: number }).height ?? 44
        const contentRows = chart() ? 18 : 8
        return Math.max(0, Math.floor(rows / 3 - contentRows / 2 - 4))
      })()}
      alignItems="center"
      onMouseUp={props.onClose}
    >
      <box
        flexDirection="column"
        gap={0}
        backgroundColor={props.api.theme.current.backgroundPanel}
        paddingLeft={1}
        paddingRight={1}
      >
      <text fg={props.api.theme.current.text}>Agent Drift Over Time (Laya Alignment Score)</text>
      <box flexDirection="row" gap={2}>
        <text fg={scoreColor(props.api, detail())}>
          Current {detail()?.score.toFixed(1) ?? "—"} {GLYPH[detail()?.band ?? "unknown"]}
        </text>
        <text fg={peak() ? bandColor(props.api, bandFor(peak()!.score) as Band) : props.api.theme.current.textMuted}>
          Peak {peak()?.score.toFixed(1) ?? "—"} {peak() ? GLYPH[bandFor(peak()!.score) as Band] : "·"}
        </text>
        <text fg={props.api.theme.current.textMuted}>Avg {average().toFixed(1)}</text>
        <text fg={props.api.theme.current.textMuted}>{detail()?.history.length ?? 0} turns</text>
      </box>

      {chart() ? (
        <box flexDirection="column">
          {chart()!
            .rows.slice()
            .reverse()
            .map((cells, index) => {
              const row = CHART_HEIGHT - 1 - index
              const pct = Math.round((row / (CHART_HEIGHT - 1)) * (chart()!.yMax))
              const label = row === 0 || row === CHART_HEIGHT - 1 || row === (CHART_HEIGHT - 1) / 2
                ? `${String(pct).padStart(3)} ┤`
                : "    │"
              return <Row api={props.api} cells={cells} label={label} />
            })}
          <text fg={props.api.theme.current.textMuted}>{`  0 ┴${"─".repeat(chart()!.count + 1)}`}</text>
          <text fg={props.api.theme.current.textMuted}>{`     ${chart()!.labels}`}</text>
          <text fg={props.api.theme.current.textMuted}>{`limit ${detail()?.alert}${(detail()?.alert ?? 0) > chart()!.yMax ? " (above scale)" : ""} · y max ${chart()!.yMax} · x = turn`}</text>
          <text fg={props.api.theme.current.textMuted}>{`█ score · ░ under the line`}</text>
          <text fg={props.api.theme.current.textMuted}>{`bands: <20 on · <40 slight · <65 drifting · ≥65 off plan`}</text>
        </box>
      ) : (
        <text fg={props.api.theme.current.textMuted}>
          No scored turns yet. Run /calibrate and work for a few turns, then reopen this graph.
        </text>
      )}

      {peak() && peak()!.score >= (detail()?.warn ?? 35) ? (
        <text fg={bandColor(props.api, bandFor(peak()!.score) as Band)}>
          {` ● drift detected (${peak()!.score.toFixed(1)}) at turn ${peak()!.index + 1}`}
        </text>
      ) : (
        <text fg={props.api.theme.current.success}>● on plan</text>
      )}

      <text fg={props.api.theme.current.textMuted}>esc / q or click to close</text>
      </box>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  const openGraph = () => {
    type KeyEventLike = { name?: string; stopPropagation?: () => void }
    type KeyInput = {
      on?: (event: "keypress", handler: (event: KeyEventLike) => void) => void
      off?: (event: "keypress", handler: (event: KeyEventLike) => void) => void
    }
    const keyInput = (api.renderer as unknown as { keyInput?: KeyInput }).keyInput

    let closing = false
    const close = () => {
      if (closing) return
      closing = true
      try {
        keyInput?.off?.("keypress", onKey)
      } catch {
        // handler was never attached
      }
      try {
        api.ui.dialog.clear()
      } catch {
        // dialog already gone
      }
    }

    const onKey = (event: KeyEventLike) => {
      if (event.name === "escape" || event.name === "q") {
        event.stopPropagation?.()
        close()
      }
    }

    keyInput?.on?.("keypress", onKey)

    api.ui.dialog.replace(() => <DriftGraphDialog api={api} onClose={close} />, close)
  }

  const command = {
    title: "Drift graph",
    value: "drift.graph",
    description: "Drift over time (Laya alignment score)",
    category: "Session",
    slash: { name: "drift-graph" },
    onSelect: openGraph,
  }

  const keymap = (api as unknown as { keymap?: { registerLayer?: (layer: unknown) => unknown } }).keymap
  if (keymap?.registerLayer) {
    keymap.registerLayer({
      commands: [
        {
          name: "drift.graph",
          title: command.title,
          category: "Plugin",
          namespace: "palette",
          slashName: "drift-graph",
          run() {
            openGraph()
          },
        },
      ],
    })
  } else {
    api.command.register(() => [command])
  }

  api.slots.register({
    slots: {
      /** Persistent pill in the session sidebar. */
      sidebar_content: (_ctx: unknown, props: { session_id?: string }) => {
        const snapshot = useDrift(api, () => props?.session_id)

        const text = () => {
          const snap = snapshot()
          if (!snap) return "drift —"
          return `drift ${snap.score.toFixed(0)}/100 ${GLYPH[snap.band]} ${BAND_LABEL[snap.band]}${deltaLabel(snap.delta)}`
        }

        return (
          <box flexDirection="column">
            <box flexDirection="row" paddingLeft={1} paddingRight={1} backgroundColor={api.theme.current.backgroundElement}>
              <text fg={scoreColor(api, snapshot())}>{text()}</text>
            </box>
          </box>
        )
      },

      /** Compact badge next to the prompt for when the sidebar is closed. */
      session_prompt_right: (_ctx: unknown, props: { session_id?: string }) => {
        const snapshot = useDrift(api, () => props?.session_id)

        const label = () => {
          const snap = snapshot()
          if (!snap) return ""
          return `drift ${snap.score.toFixed(0)} ${GLYPH[snap.band]}${deltaLabel(snap.delta)}`
        }

        return (
          <box flexDirection="row">
            <text fg={scoreColor(api, snapshot())}>{label()}</text>
          </box>
        )
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "laya-drift",
  tui,
}

export default plugin
