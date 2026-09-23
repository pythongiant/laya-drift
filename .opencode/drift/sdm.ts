/**
 * Semantic Drift Monitor v2 (risk score).
 *
 * Shipped form of the offline SDM experiment (see experiments/deepswe/sdm.md):
 * paraphrase-ensemble probes + `noul` probes (defined in questions.ts), a fixed
 * reference window, three signals (JS divergence, answer flip, noul shift),
 * per-signal standardization with corpus-calibrated constants, and an e-process
 * log-evidence accumulator.
 *
 * The risk score is a ranking signal for failure risk, not a calibrated
 * probability: on the offline corpus it reaches AUC 0.844 (standardized
 * combined) vs 0.563 for the shipped single-probe score, and 0.906 for the
 * unstandardized combined signal.
 */
import { jsDivergence } from "./embed"
import { SDM_CHOICE_IDS, SDM_NOUL_IDS } from "./questions"

export const SDM_WINDOW = 3
export const SDM_CLIP_K = 3
export const SDM_BETTING = 0.9
export const SDM_RISK_K = 3

/** Null-run calibration from the offline corpus (experiments/deepswe/analysis/sdm.json). */
export const SDM_CALIBRATION: Record<string, { mean: number; sd: number }> = {
  js: { mean: 0.0507, sd: 0.0309 },
  flip: { mean: 0.2983, sd: 0.2463 },
  noul: { mean: 0.0083, sd: 0.0105 },
}

export type SdmSignals = {
  js: number
  flip: number
  noul: number
  meanZ: number
  risk: number
}

export type SdmVector = Record<string, number[]>

function argmax(values: number[]): number {
  let best = 0
  for (let index = 1; index < values.length; index += 1) if (values[index]! > values[best]!) best = index
  return best
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value))
}

function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0
}

function z(value: number, calibration: { mean: number; sd: number }): number {
  return clamp((value - calibration.mean) / Math.max(1e-9, SDM_CLIP_K * calibration.sd), -1, 1)
}

/**
 * Signals for the current turn against the fixed reference window.
 * `window` holds the probability vectors of the first substantive turns.
 */
export function sdmSignals(
  window: SdmVector[],
  current: SdmVector,
  calibration: Record<string, { mean: number; sd: number }> = SDM_CALIBRATION,
): SdmSignals {
  const references = window.length ? window : [current]
  const jsValues: number[] = []
  const flips: number[] = []
  const noulValues: number[] = []

  for (const id of SDM_CHOICE_IDS) {
    const now = current[id]
    if (!now) continue
    const distances: number[] = []
    const votes = new Map<number, number>()
    for (const reference of references) {
      const past = reference[id]
      if (!past) continue
      distances.push(jsDivergence(past, now))
      const key = argmax(past)
      votes.set(key, (votes.get(key) ?? 0) + 1)
    }
    if (distances.length) jsValues.push(mean(distances))
    let majority = 0
    let bestCount = -1
    for (const [key, count] of votes) {
      if (count > bestCount) {
        bestCount = count
        majority = key
      }
    }
    if (votes.size) flips.push(argmax(now) === majority ? 0 : 1)
  }

  for (const id of SDM_NOUL_IDS) {
    const now = current[id]
    if (!now) continue
    const past = references.map((reference) => reference[id]?.[1]).filter((value): value is number => typeof value === "number")
    if (past.length) noulValues.push(Math.abs((now[1] ?? 0) - mean(past)))
  }

  const js = mean(jsValues)
  const flip = mean(flips)
  const noul = mean(noulValues)
  const meanZ = mean([z(js, calibration.js!), z(flip, calibration.flip!), z(noul, calibration.noul!)])
  const risk = 100 * (1 - Math.exp(-SDM_RISK_K * clamp(meanZ, 0, 1)))
  return { js, flip, noul, meanZ, risk }
}

/** e-process log-evidence accumulation (betting on the standardized mean). */
export function sdmLogEvidence(previousLogE: number, meanZ: number, betting = SDM_BETTING): number {
  return previousLogE + Math.log(Math.max(1e-6, 1 + betting * clamp(meanZ, -1, 1)))
}

/** log(1/alpha): the evidence level at which the e-process would alarm. */
export function sdmAlarmLevel(alpha = 0.1): number {
  return Math.log(1 / Math.max(1e-6, alpha))
}
