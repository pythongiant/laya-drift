/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createSignal, onCleanup } from "solid-js"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const POLL_MS = 800

type Band = "on-plan" | "slight" | "drifting" | "off-plan" | "unknown"

type Snapshot = {
  score: number
  band: Band
  delta: number
  top: string
  updatedAt: number
}

function expandHome(path: string): string {
  if (path === "~") return homedir()
  if (path.startsWith("~/")) return join(homedir(), path.slice(2))
  return path
}

function resolveStateDir(api: TuiPluginApi): string {
  try {
    const directory = api.state.path.directory
    const file = join(directory, ".opencode", "drift.json")
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, "utf8")) as { stateDir?: string }
      if (raw.stateDir) return expandHome(raw.stateDir)
    }
  } catch {
    // fall through to the default
  }
  return join(homedir(), ".local", "share", "laya-drift")
}

function readSnapshot(stateDir: string, sessionID: string): Snapshot | null {
  try {
    const safe = sessionID.replace(/[^a-zA-Z0-9_-]/g, "_")
    const file = join(stateDir, "sessions", `${safe}.json`)
    if (!existsSync(file)) return null
    const raw = JSON.parse(readFileSync(file, "utf8")) as {
      score?: number
      band?: Band
      top?: string
      updatedAt?: number
      history?: Array<{ delta?: number }>
    }
    if (typeof raw.score !== "number") return null
    const delta = raw.history?.length ? raw.history[raw.history.length - 1]?.delta ?? 0 : 0
    return {
      score: raw.score,
      band: raw.band ?? "unknown",
      delta,
      top: raw.top ?? "",
      updatedAt: raw.updatedAt ?? 0,
    }
  } catch {
    return null
  }
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

function scoreColor(api: TuiPluginApi, snapshot: Snapshot | null) {
  const theme = api.theme.current
  if (!snapshot) return theme.textMuted
  return snapshot.score < 50 ? theme.success : theme.error
}

function deltaLabel(delta: number): string {
  if (delta > 0.5) return ` ▲${delta.toFixed(0)}`
  if (delta < -0.5) return ` ▼${Math.abs(delta).toFixed(0)}`
  return ""
}

/** Polls the session drift state; keeps the TUI in sync after every turn. */
function useDrift(api: TuiPluginApi, sessionID: () => string | undefined) {
  // api.state paths sync after plugin init, so resolve on first poll.
  let cachedStateDir: string | null = null
  const stateDir = () => (cachedStateDir ??= resolveStateDir(api))
  const [snapshot, setSnapshot] = createSignal<Snapshot | null>(null)
  const timer = setInterval(() => {
    const id = sessionID()
    if (!id) return
    setSnapshot(readSnapshot(stateDir(), id))
  }, POLL_MS)
  onCleanup(() => clearInterval(timer))
  return snapshot
}

const tui: TuiPlugin = async (api) => {
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
