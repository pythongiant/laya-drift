import { computeDrift, vectorize } from "./embed"
import { baselineState, buildDigest, derivePlan, recentFocus } from "./digest"
import { DRIFT_QUESTIONS, QUESTIONS_VERSION } from "./questions"
import { readState, writeState } from "./store"
import { ensureDaemon, scoreWithLaya } from "./daemon"
import type { Logger } from "./daemon"
import type { DriftConfig } from "./config"
import type { DriftResult, DriftState, LayaResponse } from "./types"

export type ClientLike = {
  session: {
    messages: (args: unknown) => Promise<{ data?: unknown }>
    todo: (args: unknown) => Promise<{ data?: unknown }>
  }
}

type MessageLike = { info?: { role?: string }; parts?: unknown[] }

async function fetchContext(
  client: ClientLike,
  sessionID: string,
  log: Logger,
): Promise<{ messages: MessageLike[]; todos: unknown[] }> {
  let messages: MessageLike[] = []
  let todos: unknown[] = []
  try {
    const response = await client.session.messages({ path: { id: sessionID }, query: { limit: 40 } })
    if (Array.isArray(response.data)) messages = response.data as MessageLike[]
  } catch (error) {
    log("warn", `could not read session messages: ${String(error)}`)
  }
  try {
    const response = await client.session.todo({ path: { id: sessionID } })
    if (Array.isArray(response.data)) todos = response.data
  } catch {
    // todos are optional
  }
  return { messages, todos }
}

async function embed(
  directory: string,
  config: DriftConfig,
  log: Logger,
  state: string,
): Promise<Record<string, number[]>> {
  const health = await ensureDaemon(directory, config, log)
  if (!health?.ready) {
    throw new Error(health?.error ?? "drift daemon is not available")
  }
  const response: LayaResponse = await scoreWithLaya(config, state, DRIFT_QUESTIONS)
  if (!response.ok || !response.answers) {
    throw new Error(response.error ?? "laya returned no answers")
  }
  return vectorize(response.answers)
}

function hasActivity(messages: MessageLike[]): boolean {
  return messages.some((message) => (message.parts ?? []).length > 0)
}

/**
 * Baseline state for calibration. When the session already has activity, the
 * baseline is the *current digest* so that recalibrating measures drift from
 * the moment of recalibration, not from the history that predates it. Without
 * activity the positive exemplar is used, because plan-alone states answer
 * structurally different questions on the base checkpoints.
 */
function baselineFor(
  anchor: string,
  messages: MessageLike[],
  todos: unknown[],
  budgetChars: number,
): string {
  if (!hasActivity(messages)) return baselineState(anchor)
  return buildDigest({ anchor, messages: messages as never, todos: todos as never, budgetChars })
}

export async function calibrate(input: {
  client: ClientLike
  directory: string
  config: DriftConfig
  log: Logger
  sessionID: string
  plan?: string
  checkpoint?: string
}): Promise<DriftState> {
  const { client, directory, config, log, sessionID } = input
  const { messages, todos } = await fetchContext(client, sessionID, log)
  const anchor = input.plan?.trim() || derivePlan(messages as never, todos as never)
  const baseline = await embed(
    directory,
    config,
    log,
    baselineFor(anchor, messages, todos, config.scoring.digestChars),
  )
  const now = Date.now()
  const state: DriftState = {
    sessionID,
    version: QUESTIONS_VERSION,
    calibratedAt: now,
    anchor,
    anchorHistory: [],
    baseline,
    score: 0,
    previousScore: 0,
    band: "on-plan",
    top: "baseline",
    perQuestion: Object.fromEntries(Object.keys(baseline).map((key) => [key, 0])),
    history: [],
    modelCheckpoint: config.daemon.checkpoint,
    updatedAt: now,
  }
  writeState(config.stateDir, state)
  log("info", `calibrated session ${sessionID} (anchor ${anchor.length} chars)`)
  return state
}

export async function recalibrate(input: {
  client: ClientLike
  directory: string
  config: DriftConfig
  log: Logger
  sessionID: string
  plan?: string
}): Promise<DriftState> {
  const { client, directory, config, log, sessionID } = input
  const previous = readState(config.stateDir, sessionID)
  const { messages, todos } = await fetchContext(client, sessionID, log)
  const context = input.plan?.trim() || recentFocus(messages as never)
  const base = previous?.anchor ?? derivePlan(messages as never, todos as never)
  const anchor = `${base}\n\nCURRENT DIRECTION (accepted as the new baseline):\n${context}`
  const baseline = await embed(
    directory,
    config,
    log,
    baselineFor(anchor, messages, todos, config.scoring.digestChars),
  )
  const now = Date.now()
  const state: DriftState = {
    sessionID,
    version: QUESTIONS_VERSION,
    calibratedAt: now,
    anchor,
    anchorHistory: [...(previous?.anchorHistory ?? []), ...(previous ? [previous.anchor] : [])],
    baseline,
    score: 0,
    previousScore: 0,
    band: "on-plan",
    top: "baseline",
    perQuestion: Object.fromEntries(Object.keys(baseline).map((key) => [key, 0])),
    history: [],
    modelCheckpoint: config.daemon.checkpoint,
    updatedAt: now,
  }
  writeState(config.stateDir, state)
  log("info", `recalibrated session ${sessionID} (anchor ${anchor.length} chars)`)
  return state
}

const inflight = new Map<string, Promise<DriftResult | null>>()
const lastRun = new Map<string, number>()

export async function scoreSession(input: {
  client: ClientLike
  directory: string
  config: DriftConfig
  log: Logger
  sessionID: string
  trigger: string
  force?: boolean
}): Promise<DriftResult | null> {
  const { client, directory, config, log, sessionID, trigger } = input
  const state = readState(config.stateDir, sessionID)
  if (!state) return null
  const pending = inflight.get(sessionID)
  if (pending) return pending
  const now = Date.now()
  if (!input.force && now - (lastRun.get(sessionID) ?? 0) < config.scoring.minIntervalMs) return null
  lastRun.set(sessionID, now)

  const task = (async (): Promise<DriftResult | null> => {
    try {
      const { messages, todos } = await fetchContext(client, sessionID, log)
      const digest = buildDigest({
        anchor: state.anchor,
        messages: messages as never,
        todos: todos as never,
        budgetChars: config.scoring.digestChars,
      })
      const current = await embed(directory, config, log, digest)
      const drift = computeDrift(state.baseline, current, config.scoring.weights, config.scoring.sensitivity)
      drift.delta = Math.round((drift.score - state.score) * 10) / 10
      const updated: DriftState = {
        ...state,
        previousScore: state.score,
        score: drift.score,
        band: drift.band,
        top: drift.top,
        perQuestion: drift.perQuestion,
        history: [
          ...state.history,
          { at: drift.at, score: drift.score, delta: drift.delta, top: drift.top, trigger },
        ].slice(-config.scoring.historyLimit),
      }
      writeState(config.stateDir, updated)
      return drift
    } catch (error) {
      log("warn", `drift scoring skipped: ${error instanceof Error ? error.message : String(error)}`)
      return null
    } finally {
      inflight.delete(sessionID)
    }
  })()
  inflight.set(sessionID, task)
  return task
}

export function statusText(state: DriftState): string {
  const age = Math.round((Date.now() - state.calibratedAt) / 60000)
  const bar = "▁▂▃▄▅▆▇█"[Math.min(7, Math.floor(state.score / 12.5))] ?? "▁"
  return `DRIFT ${state.score.toFixed(1)}/100 ${bar} ${state.band} · top: ${state.top} · calibrated ${age}m ago`
}

export function reportText(state: DriftState): string {
  const lines = Object.entries(state.perQuestion)
    .sort((a, b) => b[1] - a[1])
    .map(([id, value]) => `${id}: ${(value * 100).toFixed(0)}%`)
  return [
    statusText(state),
    `turns scored: ${state.history.length}`,
    `deltas: ${state.history.slice(-8).map((entry) => entry.score.toFixed(0)).join(" → ") || "none"}`,
    `drivers: ${lines.join(", ")}`,
  ].join("\n")
}
