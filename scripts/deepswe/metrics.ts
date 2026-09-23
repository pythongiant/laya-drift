/**
 * Pure metric + parameter-fitting functions for the DeepSWE drift experiment.
 * No network, no daemon: consumes logged runs and recomputes scores from the
 * per-question divergences recorded at run time, so weight/sensitivity grids
 * are exact re-scores rather than approximations.
 *
 * Scoring protocol: like the plugin, a session with no activity at calibration
 * time anchors on its first substantive turn (that turn scores 0). Logged turn
 * vectors allow re-scoring every run under that protocol.
 */
import { computeDrift } from "../../.opencode/drift/embed"

export type Turn = {
  idx: number
  at: number
  injected?: boolean
  intervened?: boolean
  anchored?: boolean
  tools?: string[]
  score: number
  perq: Record<string, number>
  vector?: Record<string, number[]>
  digest?: string
  filesTouched?: number
  testsRun?: number
  testsPassed?: number
  usage?: Record<string, number>
}

export type Arm = "control" | "distractor" | "guided" | "oracle" | "intervene" | "verify" | "scaffold" | "stall"

export type RunLog = {
  runID: string
  task: string
  arm: Arm
  rollout: number
  injectAt?: number | null
  turns: Turn[]
  reward: number
  f2p_passed?: number
  f2p_total?: number
  p2p_passed?: number
  p2p_total?: number
  partial?: number
  apply_failed?: number
  error?: string | null
  interventions?: Array<{ turn: number; score: number; kind?: string; text: string; evidence?: Record<string, number> }>
  verifications?: Array<{ turn: number; cmd?: string; passed: number; failed: number; exitCode?: number; ms?: number }>
}

export type Params = {
  weights: Record<string, number>
  sensitivity: number
  threshold: number
}

export const DEFAULT_WEIGHTS: Record<string, number> = { alignment: 0.75, plan_ref: 0.25 }
export const DEFAULT_SENSITIVITY = 7
export const WARN_THRESHOLD = 35
export const ALERT_THRESHOLD = 65

export function weightedMean(perq: Record<string, number>, weights: Record<string, number>): number {
  let sum = 0
  let wsum = 0
  for (const [id, w] of Object.entries(weights)) {
    const d = perq[id]
    if (d === undefined) continue
    sum += w * d
    wsum += w
  }
  return wsum > 0 ? sum / wsum : 0
}

export function scoreOf(perq: Record<string, number>, weights: Record<string, number>, sensitivity: number): number {
  const mean = weightedMean(perq, weights)
  return 100 * (1 - Math.exp(-Math.max(0.1, sensitivity) * mean))
}

export function series(
  run: RunLog,
  weights: Record<string, number>,
  sensitivity: number,
  anchorFirstTurn = true,
): number[] {
  const first = anchorFirstTurn ? run.turns[0]?.vector : undefined
  return run.turns.map((turn, index) => {
    if (first && turn.vector) {
      if (index === 0) return 0
      return computeDrift(first, turn.vector, weights, sensitivity).score
    }
    return scoreOf(turn.perq, weights, sensitivity)
  })
}

/** index of the first turn after `afterIdx` with score >= threshold, or null */
export function firstCrossing(scores: number[], afterIdx: number, threshold: number): number | null {
  for (let i = Math.max(0, afterIdx + 1); i < scores.length; i += 1) {
    if (scores[i]! >= threshold) return i
  }
  return null
}

/** Mann-Whitney AUC with tie correction; positive class = `pos`. */
export function auc(pos: number[], neg: number[]): number {
  if (!pos.length || !neg.length) return Number.NaN
  const all = [...pos.map((v) => [v, 1] as const), ...neg.map((v) => [v, 0] as const)]
  all.sort((a, b) => a[0] - b[0])
  const ranks = new Array<number>(all.length).fill(0)
  let i = 0
  while (i < all.length) {
    let j = i
    while (j + 1 < all.length && all[j + 1]![0] === all[i]![0]) j += 1
    const rank = (i + j) / 2 + 1
    for (let k = i; k <= j; k += 1) ranks[k] = rank
    i = j + 1
  }
  let rankSum = 0
  for (let k = 0; k < all.length; k += 1) if (all[k]![1] === 1) rankSum += ranks[k]!
  const n1 = pos.length
  const n2 = neg.length
  return (rankSum - (n1 * (n1 + 1)) / 2) / (n1 * n2)
}

export type DetectionStats = {
  positives: number
  detected: number
  tpr: number
  falseAlarms: number
  controls: number
  fpr: number
  youden: number
  meanLatency: number
  medianLatency: number
  latencies: number[]
}

export function detectionStats(runs: RunLog[], params: Params, anchorFirstTurn = true): DetectionStats {
  const latencies: number[] = []
  let positives = 0
  let detected = 0
  let controls = 0
  let falseAlarms = 0
  for (const run of runs) {
    const scores = series(run, params.weights, params.sensitivity, anchorFirstTurn)
    if (run.arm === "distractor" && run.injectAt != null) {
      positives += 1
      const hit = firstCrossing(scores, run.injectAt, params.threshold)
      if (hit !== null) {
        detected += 1
        latencies.push(hit - run.injectAt)
      }
    } else if (run.arm !== "intervene") {
      controls += 1
      if (firstCrossing(scores, -1, params.threshold) !== null) falseAlarms += 1
    }
  }
  const sorted = [...latencies].sort((a, b) => a - b)
  const median = sorted.length
    ? sorted.length % 2
      ? sorted[(sorted.length - 1) / 2]!
      : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2
    : Number.NaN
  const tpr = positives ? detected / positives : Number.NaN
  const fpr = controls ? falseAlarms / controls : Number.NaN
  return {
    positives,
    detected,
    tpr,
    falseAlarms,
    controls,
    fpr,
    youden: (Number.isNaN(tpr) ? 0 : tpr) - (Number.isNaN(fpr) ? 0 : fpr),
    meanLatency: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : Number.NaN,
    medianLatency: median,
    latencies: sorted,
  }
}

export type FitRow = {
  weights: Record<string, number>
  sensitivity: number
  threshold: number
  stats: DetectionStats
}

export type FitResult = {
  best: FitRow | null
  rows: FitRow[]
  defaults: FitRow | null
}

export type GridOptions = {
  alignmentWeights?: number[]
  sensitivities?: number[]
  thresholds?: number[]
}

function gridWeights(alignments: number[]): Array<Record<string, number>> {
  return alignments.map((a) => ({ alignment: Math.round(a * 100) / 100, plan_ref: Math.round((1 - a) * 100) / 100 }))
}

export function fitParams(runs: RunLog[], options: GridOptions = {}, anchorFirstTurn = true): FitResult {
  const alignments = options.alignmentWeights ?? range(0.5, 1.0, 0.05)
  const sensitivities = options.sensitivities ?? [1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 10, 12, 15]
  const thresholds = options.thresholds ?? range(5, 80, 5)
  const rows: FitRow[] = []
  for (const weights of gridWeights(alignments)) {
    for (const sensitivity of sensitivities) {
      for (const threshold of thresholds) {
        const params: Params = { weights, sensitivity, threshold }
        rows.push({ weights, sensitivity, threshold, stats: detectionStats(runs, params, anchorFirstTurn) })
      }
    }
  }
  const rank = (row: FitRow): number[] => [
    -(row.stats.youden ?? 0),
    Number.isNaN(row.stats.meanLatency) ? 99 : row.stats.meanLatency,
    -row.stats.detected,
    row.sensitivity,
    row.threshold,
  ]
  const cmp = (a: FitRow, b: FitRow): number => {
    const ra = rank(a)
    const rb = rank(b)
    for (let i = 0; i < ra.length; i += 1) {
      if (ra[i]! !== rb[i]!) return ra[i]! - rb[i]!
    }
    return 0
  }
  rows.sort(cmp)
  const defaults = rows.find(
    (row) =>
      row.sensitivity === DEFAULT_SENSITIVITY &&
      row.threshold === WARN_THRESHOLD &&
      row.weights.alignment === DEFAULT_WEIGHTS.alignment,
  )
  return { best: rows[0] ?? null, rows, defaults: defaults ?? null }
}

export type OutcomeAuc = {
  auc: number
  failures: number
  successes: number
  fraction: number
}

/** Generic threshold/sensitivity fit for an arbitrary question set (uniform weights). */
export function fitThreshold(
  runs: RunLog[],
  weights: Record<string, number>,
  sensitivities: number[],
  thresholds: number[],
  anchorFirstTurn = true,
): { best: FitRow | null; rows: FitRow[] } {
  const rows: FitRow[] = []
  for (const sensitivity of sensitivities) {
    for (const threshold of thresholds) {
      const params: Params = { weights, sensitivity, threshold }
      rows.push({ weights, sensitivity, threshold, stats: detectionStats(runs, params, anchorFirstTurn) })
    }
  }
  rows.sort((a, b) => {
    const diff = (b.stats.youden || 0) - (a.stats.youden || 0)
    if (diff !== 0) return diff
    const latencyA = Number.isNaN(a.stats.meanLatency) ? 99 : a.stats.meanLatency
    const latencyB = Number.isNaN(b.stats.meanLatency) ? 99 : b.stats.meanLatency
    if (latencyA !== latencyB) return latencyA - latencyB
    return a.sensitivity - b.sensitivity
  })
  return { best: rows[0] ?? null, rows }
}

/** Best outcome AUC over the sensitivity grid for a fixed question set (uniform weights). */
export function bestOutcomeAuc(
  runs: RunLog[],
  weights: Record<string, number>,
  sensitivities: number[],
  fraction = 0.8,
  anchorFirstTurn = true,
): { auc: number; sensitivity: number; outcome: OutcomeAuc } {
  let best: { auc: number; sensitivity: number; outcome: OutcomeAuc } | null = null
  for (const sensitivity of sensitivities) {
    const outcome = outcomeAuc(runs, weights, sensitivity, fraction, anchorFirstTurn)
    if (!best || (Number.isFinite(outcome.auc) && outcome.auc > best.auc)) {
      best = { auc: outcome.auc, sensitivity, outcome }
    }
  }
  return best ?? { auc: Number.NaN, sensitivity: Number.NaN, outcome: { auc: Number.NaN, failures: 0, successes: 0, fraction } }
}

export type OutcomeFitRow = {
  weights: Record<string, number>
  sensitivity: number
  outcome: OutcomeAuc
}

export type OutcomeFit = {
  best: OutcomeFitRow | null
  rows: OutcomeFitRow[]
}

/** Grid over weights + sensitivity that best separates eventual failure by early drift. */
export function fitOutcomeParams(
  runs: RunLog[],
  options: GridOptions = {},
  fraction = 0.8,
  anchorFirstTurn = true,
): OutcomeFit {
  const alignments = options.alignmentWeights ?? range(0.5, 1.0, 0.05)
  const sensitivities = options.sensitivities ?? [1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 10, 12, 15]
  const rows: OutcomeFitRow[] = []
  for (const weights of gridWeights(alignments)) {
    for (const sensitivity of sensitivities) {
      rows.push({ weights, sensitivity, outcome: outcomeAuc(runs, weights, sensitivity, fraction, anchorFirstTurn) })
    }
  }
  rows.sort((a, b) => {
    const diff = (b.outcome.auc || -1) - (a.outcome.auc || -1)
    if (diff !== 0) return diff
    return a.sensitivity - b.sensitivity
  })
  return { best: rows[0] ?? null, rows }
}

/**
 * Does the max score over the first `fraction` of turns separate runs that end
 * up failing (reward 0 / partial < 1) from runs that end up succeeding?
 */
export function outcomeAuc(
  runs: RunLog[],
  weights: Record<string, number>,
  sensitivity: number,
  fraction = 0.8,
  anchorFirstTurn = true,
): OutcomeAuc {
  const pos: number[] = []
  const neg: number[] = []
  for (const run of runs) {
    const scores = series(run, weights, sensitivity, anchorFirstTurn)
    if (scores.length < 2) continue
    const cut = Math.max(1, Math.floor(scores.length * fraction))
    const feature = Math.max(...scores.slice(0, cut))
    const failed = (run.reward ?? 0) === 0
    if (failed) pos.push(feature)
    else neg.push(feature)
  }
  return { auc: auc(pos, neg), failures: pos.length, successes: neg.length, fraction }
}

/** Average ranks with tie correction. */
export function rankValues(values: number[]): number[] {
  const order = values.map((value, index) => [value, index] as const).sort((a, b) => a[0] - b[0])
  const ranks = new Array<number>(values.length).fill(0)
  let i = 0
  while (i < order.length) {
    let j = i
    while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) j += 1
    const rank = (i + j) / 2 + 1
    for (let k = i; k <= j; k += 1) ranks[order[k]![1]] = rank
    i = j + 1
  }
  return ranks
}

/** Spearman rank correlation, tie-corrected. */
export function spearman(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length < 3) return Number.NaN
  const rx = rankValues(x)
  const ry = rankValues(y)
  const meanX = rx.reduce((a, b) => a + b, 0) / rx.length
  const meanY = ry.reduce((a, b) => a + b, 0) / ry.length
  let cov = 0
  let vx = 0
  let vy = 0
  for (let i = 0; i < rx.length; i += 1) {
    const dx = rx[i]! - meanX
    const dy = ry[i]! - meanY
    cov += dx * dy
    vx += dx * dx
    vy += dy * dy
  }
  if (vx === 0 || vy === 0) return Number.NaN
  return cov / Math.sqrt(vx * vy)
}

/**
 * Early drift (max score over the first `fraction` of turns) vs final
 * fail-to-pass fraction across runs. Positive Spearman means higher early
 * drift goes with a worse final score.
 */
export function progressCorrelation(
  runs: RunLog[],
  weights: Record<string, number>,
  sensitivity: number,
  fraction = 0.8,
  anchorFirstTurn = true,
): { spearman: number; n: number; points: Array<{ runID: string; earlyMax: number; f2p: number }> } {
  const features: number[] = []
  const outcomes: number[] = []
  const points: Array<{ runID: string; earlyMax: number; f2p: number }> = []
  for (const run of runs) {
    const scores = series(run, weights, sensitivity, anchorFirstTurn)
    if (scores.length < 2) continue
    const cut = Math.max(1, Math.floor(scores.length * fraction))
    const earlyMax = Math.max(...scores.slice(0, cut))
    const f2p = run.f2p_total ? (run.f2p_passed ?? 0) / run.f2p_total : 0
    features.push(earlyMax)
    outcomes.push(f2p)
    points.push({ runID: run.runID, earlyMax, f2p })
  }
  return { spearman: spearman(features, outcomes), n: features.length, points }
}

/** Lead time (turns before the final turn) of the first threshold crossing. */
export function leadTime(run: RunLog, params: Params, anchorFirstTurn = true): number | null {
  const scores = series(run, params.weights, params.sensitivity, anchorFirstTurn)
  const hit = firstCrossing(scores, -1, params.threshold)
  if (hit === null) return null
  return scores.length - 1 - hit
}

export function sparkline(values: number[]): string {
  const glyphs = "▁▂▃▄▅▆▇█"
  return values
    .map((v) => glyphs[Math.min(glyphs.length - 1, Math.max(0, Math.floor((v / 100) * glyphs.length)))])
    .join("")
}

function range(start: number, stop: number, step: number): number[] {
  const out: number[] = []
  const digits = step < 1 ? 2 : 0
  for (let v = start; v <= stop + 1e-9; v += step) out.push(Number(v.toFixed(digits)))
  return out
}
