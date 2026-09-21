import { DRIFT_QUESTIONS, QUESTION_ORDER, questionLabel } from "./questions"
import type { Answer, DriftBand, DriftResult, QuestionDef } from "./types"

export function vectorize(answers: Record<string, Answer>): Record<string, number[]> {
  const out: Record<string, number[]> = {}
  for (const id of QUESTION_ORDER) {
    const answer = answers[id]
    const def = DRIFT_QUESTIONS[id]
    if (!answer || !def) continue
    out[id] = probabilities(answer, def)
  }
  return out
}

function probabilities(answer: Answer, def: QuestionDef): number[] {
  if (def.type === "score") {
    const probs = "probabilities" in answer ? answer.probabilities : {}
    return Object.keys(probs)
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => probs[k] ?? 0)
  }
  if (def.type === "choice") {
    const keys = Object.keys(def.criteria)
    const probs = "probabilities" in answer ? answer.probabilities : {}
    return keys.map((k) => probs[k] ?? 0)
  }
  const p = "noul" in answer ? answer.noul : 0
  return [1 - p, p]
}

/** Jensen-Shannon divergence, log base 2, in [0, 1]. */
export function jsDivergence(p: number[], q: number[]): number {
  const n = Math.max(p.length, q.length)
  let divergence = 0
  for (let i = 0; i < n; i += 1) {
    const pi = p[i] ?? 0
    const qi = q[i] ?? 0
    const m = (pi + qi) / 2
    if (pi > 0) divergence += 0.5 * pi * Math.log2(pi / m)
    if (qi > 0) divergence += 0.5 * qi * Math.log2(qi / m)
  }
  return Math.min(1, Math.max(0, divergence))
}

export function questionDivergence(id: string, base: number[], current: number[]): number {
  const def = DRIFT_QUESTIONS[id]
  if (!def) return 0
  if (def.type === "noul") {
    return Math.min(1, Math.abs((base[1] ?? 0) - (current[1] ?? 0)))
  }
  return jsDivergence(base, current)
}

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

export function bandFor(score: number): DriftBand {
  if (score < 20) return "on-plan"
  if (score < 40) return "slight"
  if (score < 65) return "drifting"
  return "off-plan"
}

export function bandGlyph(band: DriftBand): string {
  switch (band) {
    case "on-plan":
      return "●"
    case "slight":
      return "◐"
    case "drifting":
      return "◑"
    case "off-plan":
      return "○"
    default:
      return "·"
  }
}

export function computeDrift(
  baseline: Record<string, number[]>,
  current: Record<string, number[]>,
  weights: Record<string, number>,
  sensitivity: number,
): DriftResult {
  const perQuestion: Record<string, number> = {}
  let weighted = 0
  let weightSum = 0
  for (const id of QUESTION_ORDER) {
    const base = baseline[id]
    const cur = current[id]
    if (!base || !cur) continue
    const d = questionDivergence(id, base, cur)
    perQuestion[id] = round(d, 4)
    const weight = weights[id] ?? 0
    weighted += weight * d
    weightSum += weight
  }
  const mean = weightSum > 0 ? weighted / weightSum : 0
  // Saturating curve keeps the 0-100 range meaningful across very different
  // digests instead of clipping at the ceiling.
  const score = 100 * (1 - Math.exp(-Math.max(0.1, sensitivity) * mean))
  const top = Object.entries(perQuestion).sort((a, b) => b[1] - a[1])[0]?.[0] ?? ""
  return {
    score: round(score, 1),
    delta: 0,
    band: bandFor(score),
    top: top ? questionLabel(top) : "none",
    perQuestion,
    at: Date.now(),
  }
}

export function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
