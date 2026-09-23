/**
 * Offline self-test for the experiment metrics: no network, no daemon.
 * Exits non-zero when any check fails. Called by tests/test_js_drift_early_detection.py.
 *
 *   bun scripts/deepswe/selftest.ts
 */
import { computeDrift } from "../../.opencode/drift/embed"
import { DRIFT_QUESTIONS } from "../../.opencode/drift/questions"
import { auc, detectionStats, firstCrossing, fitParams, leadTime, outcomeAuc, scoreOf, series, weightedMean } from "./metrics"
import type { RunLog, Turn } from "./metrics"

let failures = 0

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`ok   ${name}`)
  } else {
    failures += 1
    console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`)
  }
}

function approx(a: number, b: number, tolerance = 1e-9): boolean {
  return Math.abs(a - b) <= tolerance
}

function turn(idx: number, perq: Record<string, number>): Turn {
  return { idx, at: idx * 1000, score: scoreOf(perq, { alignment: 0.75, plan_ref: 0.25 }, 7), perq }
}

const calm = { alignment: 0.02, plan_ref: 0.01 }
const drift = { alignment: 0.45, plan_ref: 0.2 }

const distractorRun: RunLog = {
  runID: "synthetic__distractor",
  task: "synthetic",
  arm: "distractor",
  rollout: 1,
  injectAt: 2,
  turns: [turn(1, calm), turn(2, calm), turn(3, drift), turn(4, drift)],
  reward: 0,
  f2p_passed: 0,
  f2p_total: 10,
}
const controlRun: RunLog = {
  runID: "synthetic__control",
  task: "synthetic",
  arm: "control",
  rollout: 1,
  turns: [turn(1, calm), turn(2, calm), turn(3, calm), turn(4, calm)],
  reward: 1,
  f2p_passed: 10,
  f2p_total: 10,
}

check("auc separates classes", approx(auc([0.9, 0.8], [0.1, 0.2]), 1))
check("auc reverses with labels", approx(auc([0.1, 0.2], [0.9, 0.8]), 0))
check("auc handles ties", approx(auc([0.5], [0.5]), 0.5))
check("firstCrossing finds first hit after index", firstCrossing([1, 2, 50, 60], 1, 40) === 2)
check("firstCrossing respects start", firstCrossing([1, 2, 50, 60], 2, 40) === 3)
check("firstCrossing none", firstCrossing([1, 2, 3], -1, 40) === null)

const perq = { alignment: 0.3, plan_ref: 0.1 }
const weights = { alignment: 0.75, plan_ref: 0.25 }
const sensitivity = 7
check("weightedMean respects weights", approx(weightedMean(perq, weights), 0.75 * 0.3 + 0.25 * 0.1))
const baselineVector = { alignment: [1, 0, 0], plan_ref: [1, 0, 0] }
const currentVector = { alignment: [0.2, 0.3, 0.5], plan_ref: [0.5, 0.5, 0] }
const driftResult = computeDrift(baselineVector, currentVector, weights, sensitivity)
check(
  "scoreOf matches computeDrift",
  approx(scoreOf(driftResult.perQuestion, weights, sensitivity), driftResult.score, 0.05),
  `scoreOf=${scoreOf(driftResult.perQuestion, weights, sensitivity)} computeDrift=${driftResult.score}`,
)
check(
  "per-question divergences are weight-independent",
  approx(driftResult.perQuestion.alignment!, computeDrift(baselineVector, currentVector, { alignment: 0.1, plan_ref: 0.9 }, sensitivity).perQuestion.alignment!, 1e-9),
)

const stats = detectionStats([distractorRun, controlRun], { weights, sensitivity, threshold: 35 })
check("detection stats TPR", stats.tpr === 1, `tpr=${stats.tpr}`)
check("detection stats FPR", stats.fpr === 0, `fpr=${stats.fpr}`)
check("detection latency measured from injection", stats.latencies[0] === 1, `latency=${stats.latencies[0]}`)

const fit = fitParams([distractorRun, controlRun], {
  alignmentWeights: [0.75],
  sensitivities: [7],
  thresholds: [20, 35, 50],
})
check("fit finds a perfect separator", fit.best !== null && fit.best.stats.youden === 1)
check("fit ranks lowest-latency threshold first", fit.rows[0]!.threshold <= 50)

const outcome = outcomeAuc([distractorRun, controlRun], weights, sensitivity, 0.8)
check("outcome AUC separates failing from succeeding runs", approx(outcome.auc, 1))

check("lead time on crossing run", leadTime(distractorRun, { weights, sensitivity, threshold: 35 }) === 1)
check("series length matches turns", series(distractorRun, weights, sensitivity).length === distractorRun.turns.length)

const questionIds = Object.keys(DRIFT_QUESTIONS)
check("synthetic fixtures use real question ids", questionIds.every((id) => id in perq))

if (failures) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log("\nall metric checks passed")
