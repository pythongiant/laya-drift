import { computeDrift, vectorizeWith } from "./embed"
import { derivePlan, hasSubstantiveActivity, recentFocus, stateFor } from "./digest"
import { historyPoints, renderGraph } from "./graph"
import { ALL_QUESTIONS, DRIFT_QUESTIONS, QUESTIONS_VERSION, SDM_CHOICE_IDS, SDM_NOUL_IDS } from "./questions"
import { SDM_WINDOW, sdmLogEvidence, sdmSignals } from "./sdm"
import type { SdmVector } from "./sdm"
import { readAllStates, readState, writeState } from "./store"
import { ensureDaemon, scoreWithLaya } from "./daemon"
import { basename } from "node:path"
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
  const response: LayaResponse = await scoreWithLaya(config, state, ALL_QUESTIONS)
  if (!response.ok || !response.answers) {
    throw new Error(response.error ?? "laya returned no answers")
  }
  return vectorizeWith(response.answers, ALL_QUESTIONS)
}

function sdmSlice(vectors: Record<string, number[]>): SdmVector {
  const out: SdmVector = {}
  for (const id of [...SDM_CHOICE_IDS, ...SDM_NOUL_IDS]) {
    if (vectors[id]) out[id] = vectors[id]!
  }
  return out
}

/** Fixed reference window: keep the first substantive turns, reset on recalibration. */
function nextWindow(window: SdmVector[] | undefined, current: SdmVector, anchorNow: boolean): SdmVector[] {
  if (anchorNow || !window?.length) return [current]
  if (window.length < SDM_WINDOW) return [...window, current]
  return window
}

/**
 * State text for calibration: the current digest when the session has
 * substantive activity (so recalibration resets the score to the state at that
 * moment), otherwise the positive exemplar. See stateFor in digest.ts.
 */
function stateText(anchor: string, messages: MessageLike[], todos: unknown[], budgetChars: number): string {
  return stateFor({ anchor, messages: messages as never, todos: todos as never, budgetChars })
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
  const hasActivity = hasSubstantiveActivity(messages as never)
  const baseline = await embed(
    directory,
    config,
    log,
    stateText(anchor, messages, todos, config.scoring.digestChars),
  )
  const now = Date.now()
  const state: DriftState = {
    sessionID,
    directory,
    version: QUESTIONS_VERSION,
    calibratedAt: now,
    anchor,
    anchorHistory: [],
    baseline,
    awaitingFirstActivity: !hasActivity,
    score: 0,
    previousScore: 0,
    band: "on-plan",
    top: "baseline",
    perQuestion: Object.fromEntries(Object.keys(DRIFT_QUESTIONS).map((key) => [key, 0])),
    history: [],
    modelCheckpoint: config.daemon.checkpoint,
    updatedAt: now,
    sdmWindow: [],
    risk: 0,
    riskLogE: 0,
    riskSignals: { js: 0, flip: 0, noul: 0 },
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
  const hasActivity = hasSubstantiveActivity(messages as never)
  const baseline = await embed(
    directory,
    config,
    log,
    stateText(anchor, messages, todos, config.scoring.digestChars),
  )
  const now = Date.now()
  const state: DriftState = {
    sessionID,
    directory,
    version: QUESTIONS_VERSION,
    calibratedAt: now,
    anchor,
    anchorHistory: [...(previous?.anchorHistory ?? []), ...(previous ? [previous.anchor] : [])],
    baseline,
    awaitingFirstActivity: !hasActivity,
    score: 0,
    previousScore: 0,
    band: "on-plan",
    top: "baseline",
    perQuestion: Object.fromEntries(Object.keys(DRIFT_QUESTIONS).map((key) => [key, 0])),
    sdmWindow: [],
    risk: 0,
    riskLogE: 0,
    riskSignals: { js: 0, flip: 0, noul: 0 },
    history: [
      ...(previous?.history ?? []),
      {
        at: now,
        score: 0,
        delta: previous ? Math.round(-previous.score * 10) / 10 : 0,
        top: "recalibrated",
        trigger: "recalibrate",
      },
    ].slice(-config.scoring.historyLimit),
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
  /**
   * Text of the just-received prompt. chat.message fires before the message is
   * persisted, so without this the digest lags one turn and repeats scores.
   */
  extraText?: string
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
      const withPrompt = input.extraText?.trim()
        ? [...messages, { info: { role: "user" }, parts: [{ type: "text", text: input.extraText.trim() }] }]
        : messages
      const digest = stateText(state.anchor, withPrompt, todos, config.scoring.digestChars)
      const current = await embed(directory, config, log, digest)
      const hasActivity = hasSubstantiveActivity(withPrompt as never)
      const anchorNow = Boolean(state.awaitingFirstActivity && hasActivity)
      const baseline = anchorNow ? current : state.baseline
      const drift = computeDrift(baseline, current, config.scoring.weights, config.scoring.sensitivity)
      drift.delta = Math.round((drift.score - state.score) * 10) / 10
      const sdmCurrent = sdmSlice(current)
      const window = nextWindow(state.sdmWindow, sdmCurrent, anchorNow)
      let risk = 0
      let riskLogE = 0
      let riskSignals = { js: 0, flip: 0, noul: 0 }
      if (config.risk.enabled) {
        const signals = sdmSignals(window, sdmCurrent)
        risk = Math.round(signals.risk * 10) / 10
        riskLogE = sdmLogEvidence(state.riskLogE ?? 0, signals.meanZ, config.risk.betting)
        riskSignals = { js: signals.js, flip: signals.flip, noul: signals.noul }
        drift.risk = risk
        drift.riskSignals = riskSignals
      }
      if (anchorNow) log("info", `anchored session ${sessionID} on its first activity`)
      const updated: DriftState = {
        ...state,
        baseline,
        awaitingFirstActivity: Boolean(state.awaitingFirstActivity && !hasActivity),
        previousScore: state.score,
        score: drift.score,
        band: drift.band,
        top: drift.top,
        perQuestion: drift.perQuestion,
        sdmWindow: window,
        risk,
        riskLogE,
        riskSignals,
        history: [
          ...state.history,
          { at: drift.at, score: drift.score, delta: drift.delta, top: drift.top, trigger, risk },
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

/** Text chart of one session's drift history (chat fallback). */
export function sessionGraph(state: DriftState, config: DriftConfig): string {
  const points = historyPoints(state.history)
  const anchor = state.anchor.split("\n")[0]?.slice(0, 50) ?? ""
  const title = `drift over time · session ${state.sessionID.slice(0, 12)} · anchor: ${anchor}`
  const caption = `text chart · bars = score, sparkline = per-turn · thresholds warn ${config.display.warnThreshold} / alert ${config.display.alertThreshold}`
  return renderGraph(points, title, caption)
}

/** Text chart across every session of this project (merged chronologically). */
export function repoGraph(directory: string, config: DriftConfig): string {
  const states = readAllStates(config.stateDir).filter(
    (state) => state.directory === directory && state.history.length > 0,
  )
  const points = states
    .flatMap((state) => historyPoints(state.history, state.sessionID.slice(0, 8)))
    .sort((a, b) => a.at - b.at)
  const title = `drift over time · repo ${basename(directory)} · ${states.length} session(s) · ${points.length} scored turns`
  const caption = `text chart · bars = score, sparkline = per-turn · thresholds warn ${config.display.warnThreshold} / alert ${config.display.alertThreshold}`
  return renderGraph(points, title, caption)
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
  const riskLine =
    typeof state.risk === "number"
      ? `risk: ${state.risk.toFixed(1)}/100 (js ${state.riskSignals?.js.toFixed(3) ?? "?"}, flip ${state.riskSignals?.flip.toFixed(2) ?? "?"}, noul ${state.riskSignals?.noul.toFixed(3) ?? "?"}) · e-process logE ${(state.riskLogE ?? 0).toFixed(2)}`
      : "risk: disabled"
  return [
    statusText(state),
    `turns scored: ${state.history.length}`,
    `deltas: ${state.history.slice(-8).map((entry) => entry.score.toFixed(0)).join(" → ") || "none"}`,
    `drivers: ${lines.join(", ")}`,
    riskLine,
  ].join("\n")
}
