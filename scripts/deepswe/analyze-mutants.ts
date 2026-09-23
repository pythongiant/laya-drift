/**
 * Analysis for the local-verifier micro-benchmark (mutants).
 *
 * Runs are real agent runs on mutated DeepSWE repositories where the reference
 * tests are visible and runnable, so outcomes are mixed and progress is
 * measurable per turn. Compares early-warning signals (semantic drift vs
 * execution evidence vs the stall rule the monitor would use) and the effect of
 * the monitor-triggered stall nudge.
 *
 *   bun scripts/deepswe/analyze-mutants.ts
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { auc, series, DEFAULT_SENSITIVITY, DEFAULT_WEIGHTS } from "./metrics"
import type { RunLog } from "./metrics"

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "")
const RUNS = join(ROOT, "experiments", "deepswe", "runs")
const ANALYSIS = join(ROOT, "experiments", "deepswe", "analysis")
const PLOTS = join(ANALYSIS, "plots")

type MutantRun = RunLog & {
  interventions?: Array<{ turn: number; kind?: string; text: string; evidence?: Record<string, number> }>
}

function loadRuns(): MutantRun[] {
  const runs: MutantRun[] = []
  for (const entry of readdirSync(RUNS, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("mutant-")) continue
    const file = join(RUNS, entry.name, "run.json")
    if (!existsSync(file)) continue
    runs.push(JSON.parse(readFileSync(file, "utf8")) as MutantRun)
  }
  return runs.sort((a, b) => a.runID.localeCompare(b.runID))
}

const STALL_AFTER = 3
const MIN_TURN = 5

function f2pFraction(run: MutantRun): number {
  return run.f2p_total ? (run.f2p_passed ?? 0) / run.f2p_total : 0
}

type RunView = {
  run: MutantRun
  success: boolean
  fraction: number
  drift: number[]
  passed: number[]
  stallAlarmTurn: number | null
  nudgeTurns: number[]
  progressAfterNudge: number | null
  earlyMaxDrift: number
  earlyStallTurns: number
  earlyTestsRun: number
  earlyFiles: number
  earlyProgressGain: number
  finalGap: number
}

function view(run: MutantRun): RunView {
  const drift = series(run, DEFAULT_WEIGHTS, DEFAULT_SENSITIVITY)
  const passed = run.turns.map((turn) => turn.testsPassed ?? 0)
  const testsRun = run.turns.map((turn) => turn.testsRun ?? 0)
  const files = run.turns.map((turn) => turn.filesTouched ?? 0)
  const window = Math.max(1, Math.floor(run.turns.length * 0.8))

  let lastProgress = 0
  let stallAlarmTurn: number | null = null
  const stallTurnsByTurn: number[] = []
  for (let index = 0; index < run.turns.length; index += 1) {
    const turnIndex = index + 1
    if (passed[index]! > (passed[index - 1] ?? 0)) lastProgress = turnIndex
    const stalled = turnIndex - lastProgress
    stallTurnsByTurn.push(stalled)
    if (stallAlarmTurn === null && turnIndex >= MIN_TURN && stalled >= STALL_AFTER) stallAlarmTurn = turnIndex
  }

  const nudgeTurns = (run.interventions ?? []).filter((item) => item.kind === "stall").map((item) => item.turn)
  let progressAfterNudge: number | null = null
  if (nudgeTurns.length) {
    const at = nudgeTurns[0]!
    const before = passed[Math.min(at - 1, passed.length - 1)] ?? 0
    const after = passed.at(-1) ?? 0
    progressAfterNudge = after - before
  }

  return {
    run,
    success: run.reward === 1,
    fraction: f2pFraction(run),
    drift,
    passed,
    stallAlarmTurn,
    nudgeTurns,
    progressAfterNudge,
    earlyMaxDrift: Math.max(0, ...drift.slice(0, window)),
    earlyStallTurns: Math.max(0, ...stallTurnsByTurn.slice(0, window)),
    earlyTestsRun: Math.max(0, ...testsRun.slice(0, window)),
    earlyFiles: Math.max(0, ...files.slice(0, window)),
    earlyProgressGain: (passed[window - 1] ?? 0) - (passed[0] ?? 0),
    finalGap: (run.f2p_total ?? 0) - (run.f2p_passed ?? 0),
  }
}

const runs = loadRuns().map(view)
if (!runs.length) {
  console.error("no mutant runs found")
  process.exit(1)
}

const fmt = (value: number, digits = 3): string => (Number.isFinite(value) ? value.toFixed(digits) : "n/a")

type FeatureSpec = { key: keyof RunView; label: string; higherMeansFailure: boolean }
const FEATURES: FeatureSpec[] = [
  { key: "earlyMaxDrift", label: "early max drift (semantic)", higherMeansFailure: true },
  { key: "earlyStallTurns", label: "max turns without test progress", higherMeansFailure: true },
  { key: "earlyProgressGain", label: "passing-test gain (early)", higherMeansFailure: false },
  { key: "earlyTestsRun", label: "test runs (early)", higherMeansFailure: false },
  { key: "earlyFiles", label: "files touched (early)", higherMeansFailure: false },
]

const OUTCOME_ONLY: FeatureSpec = { key: "finalGap", label: "tests still failing at end (not early)", higherMeansFailure: true }

const failures = runs.filter((item) => !item.success)
const successes = runs.filter((item) => item.success)
const featureResults = FEATURES.map((spec) => {
  const pos = failures.map((item) => Number(item[spec.key]))
  const neg = successes.map((item) => Number(item[spec.key]))
  const raw = auc(pos, neg)
  const oriented = spec.higherMeansFailure ? raw : 1 - raw
  return { ...spec, auc: oriented }
})

const arms = [...new Set(runs.map((item) => item.run.arm))]
const armStats = arms.map((arm) => {
  const subset = runs.filter((item) => item.run.arm === arm)
  const solved = subset.filter((item) => item.success).length
  const nudged = subset.reduce((sum, item) => sum + item.nudgeTurns.length, 0)
  return { arm, runs: subset.length, solved, nudges: nudged }
})

const stallRuns = runs.filter((item) => item.run.arm === "stall")
const stallDetected = stallRuns.filter((item) => item.stallAlarmTurn !== null)
const stallTruePositives = stallDetected.filter((item) => !item.success)
const stallFalsePositives = stallDetected.filter((item) => item.success)
const stallMissed = stallRuns.filter((item) => !item.success && item.stallAlarmTurn === null)

mkdirSync(ANALYSIS, { recursive: true })
mkdirSync(PLOTS, { recursive: true })
writeFileSync(
  join(ANALYSIS, "mutants.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      runs: runs.length,
      successes: successes.length,
      failures: failures.length,
      armStats,
      features: featureResults,
      stallDetector: {
        runs: stallRuns.length,
        detected: stallDetected.length,
        truePositives: stallTruePositives.length,
        falsePositives: stallFalsePositives.length,
        missed: stallMissed.length,
        leadTurns: stallTruePositives.map((item) => item.run.turns.length - item.stallAlarmTurn!),
      },
      rows: runs.map((item) => ({
        runID: item.run.runID,
        arm: item.run.arm,
        reward: item.run.reward,
        f2p: `${item.run.f2p_passed}/${item.run.f2p_total}`,
        turns: item.run.turns.length,
        earlyMaxDrift: item.earlyMaxDrift,
        earlyStallTurns: item.earlyStallTurns,
        stallAlarmTurn: item.stallAlarmTurn,
        nudges: item.nudgeTurns,
        progressAfterNudge: item.progressAfterNudge,
      })),
    },
    null,
    2,
  ),
)

const md: string[] = [
  "# Local-verifier micro-benchmark (mutants)",
  "",
  `Generated ${new Date().toISOString()} · ${runs.length} runs · reference tests visible and runnable`,
  "",
  "## Outcomes",
  "",
  "| arm | runs | solved | stall nudges |",
  "| --- | --- | --- | --- |",
  ...armStats.map((stat) => `| ${stat.arm} | ${stat.runs} | ${stat.solved}/${stat.runs} | ${stat.nudges} |`),
  "",
  "| run | arm | reward | f2p | turns | early max drift | max stall (turns) | stall alarm | nudges | progress after nudge |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ...runs.map(
    (item) =>
      `| ${item.run.runID} | ${item.run.arm} | ${item.run.reward} | ${item.run.f2p_passed}/${item.run.f2p_total} | ${item.run.turns.length} | ${fmt(item.earlyMaxDrift, 1)} | ${item.earlyStallTurns} | ${item.stallAlarmTurn ?? "-"} | ${item.nudgeTurns.join(",") || "-"} | ${item.progressAfterNudge ?? "-"} |`,
  ),
  "",
  "## Early-warning signal quality (failure = reward 0)",
  "",
  "| feature | direction | outcome AUC |",
  "| --- | --- | --- |",
  ...featureResults.map((result) => `| ${result.label} | ${result.higherMeansFailure ? "higher" : "lower"} = failure | ${fmt(result.auc)} |`),
  "",
  `Stall rule (${STALL_AFTER} turns without a new passing test, from turn ${MIN_TURN}) on the stall arm: ` +
    `${stallDetected.length}/${stallRuns.length} runs alarmed, ${stallTruePositives.length} true, ${stallFalsePositives.length} false, ${stallMissed.length} missed.`,
  "",
  "![mutant AUC](plots/mutants-auc.svg)",
  "",
  "![mutant progress](plots/mutants-progress.svg)",
]
writeFileSync(join(ANALYSIS, "mutants.md"), `${md.join("\n")}\n`)

// --- plots -------------------------------------------------------------------

const svgWrap = (width: number, height: number, body: string[]): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="-apple-system, Helvetica, Arial, sans-serif">
<style>text{fill:#111827}.tick{font-size:11px;fill:#4b5563}.label{font-size:12px;fill:#374151}.title{font-size:14px;font-weight:600}.small{font-size:11px;fill:#6b7280}</style>
${body.join("\n")}
</svg>
`

const sortedFeatures = [...featureResults].sort((a, b) => b.auc - a.auc)
const barW = 980
const barH = 90 + sortedFeatures.length * 30
const barX0 = 250
const scaleW = barW - barX0 - 90
const xScale = (value: number): number => barX0 + ((value - 0.4) / 0.6) * scaleW
const bars: string[] = [`<text x="24" y="26" class="title">Early-warning AUC on the micro-benchmark</text>`]
bars.push(`<text x="24" y="48" class="small">0.5 = chance; feature measured over the first 80% of turns</text>`)
for (const tick of [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]) {
  bars.push(`<line x1="${xScale(tick).toFixed(1)}" y1="60" x2="${xScale(tick).toFixed(1)}" y2="${barH - 24}" stroke="#f3f4f6"/>`)
  bars.push(`<text x="${xScale(tick).toFixed(1)}" y="${barH - 10}" class="tick" text-anchor="middle">${tick.toFixed(1)}</text>`)
}
sortedFeatures.forEach((feature, index) => {
  const y = 70 + index * 30
  const color = feature.auc >= 0.9 ? "#16a34a" : feature.auc >= 0.7 ? "#ca8a04" : "#9ca3af"
  bars.push(`<rect x="${barX0}" y="${y}" width="${Math.max(0, xScale(feature.auc) - barX0).toFixed(1)}" height="18" fill="${color}"/>`)
  bars.push(`<text x="${(xScale(feature.auc) + 6).toFixed(1)}" y="${y + 13}" class="tick">${fmt(feature.auc)}</text>`)
  bars.push(`<text x="${barX0 - 8}" y="${y + 13}" class="tick" text-anchor="end">${feature.label}</text>`)
})
writeFileSync(join(PLOTS, "mutants-auc.svg"), svgWrap(barW, barH, bars))

const cols = 3
const rowsCount = Math.ceil(runs.length / cols)
const cellW = 320
const cellH = 190
const gridW = cols * cellW + 40
const gridH = 84 + rowsCount * cellH
const progress: string[] = [`<text x="24" y="26" class="title">Passing tests per turn (green = solved, red = failed)</text>`]
progress.push(`<text x="24" y="48" class="small">dots = stall nudges; y = passing test count</text>`)
runs.forEach((item, index) => {
  const col = index % cols
  const row = Math.floor(index / cols)
  const x0 = 40 + col * cellW
  const y0 = 84 + row * cellH
  const w = cellW - 40
  const h = cellH - 50
  const maxTurns = Math.max(...runs.map((candidate) => candidate.run.turns.length), 6)
  const maxPassed = Math.max(1, ...runs.map((candidate) => Math.max(...candidate.passed, 0)))
  const px = (turn: number): number => x0 + ((turn - 1) / Math.max(1, maxTurns - 1)) * w
  const py = (value: number): number => y0 + h - (value / maxPassed) * h
  const color = item.success ? "#16a34a" : "#dc2626"
  progress.push(`<rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="#ffffff" stroke="#e5e7eb"/>`)
  progress.push(`<text x="${x0}" y="${y0 - 6}" class="small">${item.run.runID.replace("mutant-", "").replace("__control__r1", "").replace("__stall__r1", " stall")}</text>`)
  progress.push(
    `<path d="${item.passed.map((value, i) => `${i === 0 ? "M" : "L"}${px(i + 1).toFixed(1)} ${py(value).toFixed(1)}`).join(" ")}" fill="none" stroke="${color}" stroke-width="2"/>`,
  )
  for (const turn of item.nudgeTurns) {
    progress.push(`<circle cx="${px(turn).toFixed(1)}" cy="${py(item.passed[Math.min(turn - 1, item.passed.length - 1)] ?? 0).toFixed(1)}" r="4" fill="#b45309"/>`)
  }
})
writeFileSync(join(PLOTS, "mutants-progress.svg"), svgWrap(gridW, gridH, progress))

console.log(`runs: ${runs.length} · solved ${successes.length}/${runs.length}`)
for (const stat of armStats) console.log(`  ${stat.arm.padEnd(8)} ${stat.solved}/${stat.runs} solved, ${stat.nudges} stall nudges`)
for (const result of sortedFeatures) console.log(`  AUC ${fmt(result.auc)} ${result.label}`)
console.log(`report → ${join(ANALYSIS, "mutants.md")}`)
