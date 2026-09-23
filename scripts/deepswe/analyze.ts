/**
 * Analysis for the DeepSWE drift experiment: early-detection metrics and an
 * empirical grid search over probe weights, saturation sensitivity and alert
 * threshold. Reads the per-run JSON under experiments/deepswe/runs, writes
 * experiments/deepswe/analysis/{params.json,report.md}.
 *
 *   bun scripts/deepswe/analyze.ts [--out dir]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  DEFAULT_SENSITIVITY,
  DEFAULT_WEIGHTS,
  WARN_THRESHOLD,
  ALERT_THRESHOLD,
  detectionStats,
  fitOutcomeParams,
  fitParams,
  leadTime,
  outcomeAuc,
  progressCorrelation,
  series,
  sparkline,
} from "./metrics"
import type { Params, RunLog } from "./metrics"
import { generatePlots } from "./plots"

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "")
const RUNS = join(ROOT, "experiments", "deepswe", "runs")

function loadRuns(): RunLog[] {
  if (!existsSync(RUNS)) return []
  const runs: RunLog[] = []
  for (const entry of readdirSync(RUNS, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith("mutant-")) continue
    const file = join(RUNS, entry.name, "run.json")
    if (!existsSync(file)) continue
    runs.push(JSON.parse(readFileSync(file, "utf8")) as RunLog)
  }
  return runs.sort((a, b) => a.runID.localeCompare(b.runID))
}

function fmt(value: number, digits = 2): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "n/a"
}

function runTable(runs: RunLog[], params: Params): string {
  const header =
    "| run | task | arm | turns | reward | f2p | max score | crossing turn | latency | lead |"
  const sep = "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
  const rows = runs.map((run) => {
    const scores = series(run, params.weights, params.sensitivity)
    const max = scores.length ? Math.max(...scores) : 0
    const start = run.injectAt ?? -1
    let crossing: number | null = null
    for (let i = Math.max(0, start + 1); i < scores.length; i += 1) {
      if (scores[i]! >= params.threshold) {
        crossing = i
        break
      }
    }
    const latency = crossing !== null && run.injectAt != null ? crossing - run.injectAt : null
    const lead = leadTime(run, params)
    return `| ${run.runID} | ${run.task} | ${run.arm} | ${run.turns.length} | ${run.reward} | ${run.f2p_passed ?? "?"}/${run.f2p_total ?? "?"} | ${fmt(max, 1)} | ${crossing ?? "none"} | ${latency ?? "-"} | ${lead ?? "-"} |`
  })
  return [header, sep, ...rows].join("\n")
}

function armSummary(runs: RunLog[], params: Params): string {
  const arms = [...new Set(runs.map((run) => run.arm))]
  const header = "| arm | runs | mean reward | mean f2p | mean max drift | mean final drift |"
  const sep = "| --- | --- | --- | --- | --- | --- |"
  const rows = arms.map((arm) => {
    const subset = runs.filter((run) => run.arm === arm)
    const mean = (values: number[]): number => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : Number.NaN)
    const maxDrift = subset.map((run) => Math.max(0, ...series(run, params.weights, params.sensitivity)))
    const finalDrift = subset.map((run) => series(run, params.weights, params.sensitivity).at(-1) ?? 0)
    const f2p = subset.map((run) => (run.f2p_total ? (run.f2p_passed ?? 0) / run.f2p_total : 0))
    return `| ${arm} | ${subset.length} | ${fmt(mean(subset.map((run) => run.reward)), 2)} | ${fmt(mean(f2p), 3)} | ${fmt(mean(maxDrift), 1)} | ${fmt(mean(finalDrift), 1)} |`
  })
  return [header, sep, ...rows].join("\n")
}

type InterventionSummary = {
  runID: string
  task: string
  trigger: number | null
  kind: string
  interventions: number
  recovered: number
  verifiedAfter: boolean
  firstGreenTurn: number | null
  preMean: number
  postMean: number
  reward: number
}

function interventionSummaries(runs: RunLog[], params: Params): InterventionSummary[] {
  const out: InterventionSummary[] = []
  for (const run of runs.filter((candidate) => candidate.arm === "intervene" || candidate.arm === "verify")) {
    const scores = series(run, params.weights, params.sensitivity)
    const pre: number[] = []
    const post: number[] = []
    let recovered = 0
    const interventions = run.interventions ?? []
    for (const intervention of interventions) {
      const position = run.turns.findIndex((turn) => turn.intervened && turn.idx === intervention.turn)
      if (position < 0) continue
      const before = scores.slice(Math.max(0, position - 3), position)
      const after = scores.slice(position + 1, position + 4)
      pre.push(...before)
      post.push(...after)
      if (after.some((score) => score < params.threshold)) recovered += 1
    }
    const first = interventions[0]
    const firstPosition = first ? run.turns.findIndex((turn) => turn.intervened && turn.idx === first.turn) : -1
    const testsBefore = firstPosition >= 0 ? run.turns[firstPosition]?.testsRun ?? 0 : 0
    let verifiedAfter = false
    let firstGreenTurn: number | null = null
    if (firstPosition >= 0) {
      for (let index = firstPosition + 1; index < run.turns.length; index += 1) {
        const turn = run.turns[index]!
        if ((turn.testsRun ?? 0) > testsBefore) verifiedAfter = true
        if (firstGreenTurn === null && (turn.testsPassed ?? 0) > 0) firstGreenTurn = turn.idx
      }
    }
    const typed = run as RunLog & { interveneAbove?: number | null; verifyAfter?: number | null }
    out.push({
      runID: run.runID,
      task: run.task,
      trigger: run.arm === "verify" ? typed.verifyAfter ?? null : typed.interveneAbove ?? null,
      kind: run.arm === "verify" ? "verify" : first?.kind ?? "score",
      interventions: interventions.length,
      recovered,
      verifiedAfter,
      firstGreenTurn,
      preMean: pre.length ? pre.reduce((a, b) => a + b, 0) / pre.length : Number.NaN,
      postMean: post.length ? post.reduce((a, b) => a + b, 0) / post.length : Number.NaN,
      reward: run.reward,
    })
  }
  return out
}

type ScaffoldSummary = {
  runID: string
  task: string
  verifications: number
  firstGreenTurn: number | null
  lastPassed: number
  lastFailed: number
  actedOnFailure: boolean
  reward: number
}

function scaffoldSummaries(runs: RunLog[]): ScaffoldSummary[] {
  return runs
    .filter((run) => run.arm === "scaffold")
    .map((run) => {
      const verifications = run.verifications ?? []
      const firstGreenTurn = verifications.find((verification) => verification.passed > 0 && verification.failed === 0)?.turn ?? null
      let actedOnFailure = false
      for (const verification of verifications) {
        if (verification.failed === 0) continue
        const position = run.turns.findIndex((turn) => turn.idx === verification.turn)
        if (position < 0) continue
        const filesBefore = run.turns[position]?.filesTouched ?? 0
        const testsBefore = run.turns[position]?.testsRun ?? 0
        if (
          run.turns
            .slice(position + 1)
            .some((turn) => (turn.filesTouched ?? 0) > filesBefore || (turn.testsRun ?? 0) > testsBefore)
        ) {
          actedOnFailure = true
        }
      }
      const last = verifications.at(-1)
      return {
        runID: run.runID,
        task: run.task,
        verifications: verifications.length,
        firstGreenTurn,
        lastPassed: last?.passed ?? 0,
        lastFailed: last?.failed ?? 0,
        actedOnFailure,
        reward: run.reward,
      }
    })
}

function scaffoldSection(rows: ScaffoldSummary[]): string {
  if (!rows.length) return ""
  const verified = rows.reduce((sum, row) => sum + row.verifications, 0)
  const acted = rows.filter((row) => row.actedOnFailure).length
  const table = [
    "| run | automatic verifications | first green | last passed/failed | acted after failure | reward |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows.map(
      (row) =>
        `| ${row.runID} | ${row.verifications} | ${row.firstGreenTurn ?? "never"} | ${row.lastPassed}/${row.lastFailed} | ${row.actedOnFailure ? "yes" : "no"} | ${row.reward} |`,
    ),
  ].join("\n")
  return `## Scaffold: verifier in the loop

The \`scaffold\` arm removes the agent's choice about verification: after any
turn where files changed (or once after a fallback turn, if it never edits), the
harness runs the repository's own test suite and feeds the output back as a
user message. The held-out tests are never used as feedback.

- automatic verifier runs: ${verified} across ${rows.length} run(s)
- runs that changed files or ran tests again after a failing verifier: ${acted}/${rows.length}
- rewards: ${rows.map((row) => row.reward).join(", ")}

${table}

![scaffold objective vs drift](plots/scaffold-objective-vs-drift.svg)
`
}

function interventionSection(rows: InterventionSummary[], runs: RunLog[]): string {
  if (!rows.length) return ""
  const control = runs.filter((run) => run.arm === "control")
  const controlMean = control.length ? control.reduce((sum, run) => sum + run.reward, 0) / control.length : Number.NaN
  const intervened = rows.reduce((sum, row) => sum + row.interventions, 0)
  const recovered = rows.reduce((sum, row) => sum + row.recovered, 0)
  const meanReward = rows.reduce((sum, row) => sum + row.reward, 0) / rows.length
  const table = [
    "| run | arm | trigger | interventions | score recovered | verified after nudge | first green turn | reward |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map(
      (row) =>
        `| ${row.runID} | ${row.kind === "verify" ? "verify" : "intervene"} | ${row.trigger ?? "-"} | ${row.interventions} | ${row.recovered}/${row.interventions} | ${row.interventions ? (row.verifiedAfter ? "yes" : "no") : "-"} | ${row.firstGreenTurn ?? "-"} | ${row.reward} |`,
    ),
  ].join("\n")
  const verifyRows = rows.filter((row) => row.kind === "verify" && row.interventions > 0)
  const verifyNudges = verifyRows.reduce((sum, row) => sum + row.interventions, 0)
  const verifyActed = verifyRows.filter((row) => row.verifiedAfter).length
  return `## Closed-loop interventions

Two intervention policies:

- **intervene (v1, score-triggered)** — fires when the drift score crosses a
  threshold and sends a generic self-correction message; recovery here means the
  score fell back below the warn threshold within three turns.
- **verify (v2, evidence-triggered)** — two-stage: (a) files edited but no tests
  after N turns → "run the verifier"; (b) no edits and no tests after N+2 turns →
  "state the next objective step, then do it". Recovery target is objective
  satisfaction: tests executed after the nudge, first green test, final reward.

- v1 interventions: ${intervened - verifyNudges}, score-recovered: ${recovered - verifyRows.reduce((sum, row) => sum + row.recovered, 0)}/${intervened - verifyNudges}
- v2 nudges: ${verifyNudges} across ${verifyRows.length} run(s); runs that ran tests after the nudge: ${verifyActed}/${verifyRows.length}
- mean reward (both intervention arms): ${fmt(meanReward, 2)} (control arm: ${fmt(controlMean, 2)})

${table}
`
}

function outcomeRows(rows: ReturnType<typeof fitOutcomeParams>["rows"]): string {
  const header = "| rank | alignment | plan_ref | sensitivity | outcome AUC | failures | successes |"
  const sep = "| --- | --- | --- | --- | --- | --- | --- |"
  const body = rows.slice(0, 5).map((row, index) => {
    return `| ${index + 1} | ${row.weights.alignment} | ${row.weights.plan_ref} | ${row.sensitivity} | ${fmt(row.outcome.auc)} | ${row.outcome.failures} | ${row.outcome.successes} |`
  })
  return [header, sep, ...body].join("\n")
}

function topRows(rows: ReturnType<typeof fitParams>["rows"]): string {
  const header = "| rank | alignment | plan_ref | sensitivity | threshold | TPR | FPR | J | median latency |"
  const sep = "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"
  const body = rows.slice(0, 10).map((row, index) => {
    const s = row.stats
    return `| ${index + 1} | ${row.weights.alignment} | ${row.weights.plan_ref} | ${row.sensitivity} | ${row.threshold} | ${fmt(s.tpr)} | ${fmt(s.fpr)} | ${fmt(s.youden)} | ${fmt(s.medianLatency, 1)} |`
  })
  return [header, sep, ...body].join("\n")
}

function trajectorySection(runs: RunLog[], params: Params): string {
  const lines: string[] = []
  for (const run of runs) {
    const scores = series(run, params.weights, params.sensitivity)
    const injection = run.injectAt != null ? ` inject@${run.injectAt}` : ""
    lines.push(`- \`${run.runID}\`${injection} ${sparkline(scores)} (${scores.map((s) => s.toFixed(0)).join(" → ")})`)
  }
  return lines.join("\n")
}

const runs = loadRuns()
if (!runs.length) {
  console.error(`no runs found under ${RUNS}; run the experiment first`)
  process.exit(1)
}

const fit = fitParams(runs)
if (!fit.best) {
  console.error("grid search produced no candidate")
  process.exit(1)
}
const defaultParams: Params = { weights: DEFAULT_WEIGHTS, sensitivity: DEFAULT_SENSITIVITY, threshold: WARN_THRESHOLD }
const defaultStats = detectionStats(runs, defaultParams)
const bestParams: Params = { weights: fit.best.weights, sensitivity: fit.best.sensitivity, threshold: fit.best.threshold }
const bestStats = detectionStats(runs, bestParams)
const outcomeDefault = outcomeAuc(runs, DEFAULT_WEIGHTS, DEFAULT_SENSITIVITY)
const outcomeBest = outcomeAuc(runs, bestParams.weights, bestParams.sensitivity)
const progressDefault = progressCorrelation(runs, DEFAULT_WEIGHTS, DEFAULT_SENSITIVITY)
const progressBest = progressCorrelation(runs, bestParams.weights, bestParams.sensitivity)

const outcomeFit = fitOutcomeParams(runs)
const interventions = interventionSummaries(runs, defaultParams)
const scaffold = scaffoldSummaries(runs)
const naturalFailures = runs.filter((run) => run.arm === "control" && run.reward === 0)
const naturalLeads = naturalFailures
  .map((run) => leadTime(run, defaultParams))
  .filter((value): value is number => value !== null)

const outDir = join(ROOT, "experiments", "deepswe", "analysis")
mkdirSync(outDir, { recursive: true })
writeFileSync(
  join(outDir, "params.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      runs: runs.length,
      tasks: [...new Set(runs.map((run) => run.task))],
      arms: [...new Set(runs.map((run) => run.arm))],
      default: { params: defaultParams, stats: defaultStats, outcomeAuc: outcomeDefault, progress: progressDefault },
      best: { params: bestParams, stats: bestStats, outcomeAuc: outcomeBest, progress: progressBest },
      outcomeFit: outcomeFit.rows.slice(0, 20),
      top: fit.rows.slice(0, 20).map((row) => ({ weights: row.weights, sensitivity: row.sensitivity, threshold: row.threshold, stats: row.stats })),
      naturalFailureLeads: naturalLeads,
      interventions,
      scaffold,
    },
    null,
    2,
  ),
)

const report = `# DeepSWE drift early-detection experiment

Generated ${new Date().toISOString()} · model \`deepseek-v4.1-flash\` (OpenCode inference) · benchmark \`datacurve/deep-swe\`

## Protocol

Each run works a real DeepSWE task in a local checkout of the pinned repository
with a four-tool agent loop (bash/read/write/edit). After every assistant turn
the session state (PLAN + RECENT ACTIVITY) is probed with the plugin's Laya
questions and compared to the calibration baseline with Jensen-Shannon
divergence — the same code path the opencode plugin uses. A session with no
activity at calibration anchors on its first substantive turn (that turn scores
0, plugin behavior for fresh sessions); turn vectors are logged so every run can
be re-scored under any weight/sensitivity. Final workspaces are graded by the
benchmark's own \`grader.py\` against the held-out tests.

- runs: ${runs.length} across ${new Set(runs.map((run) => run.task)).size} task(s)
- arms: control (task prompt only), distractor (an off-plan request injected
  after turn ${runs.find((run) => run.arm === "distractor")?.injectAt ?? "n/a"}), guided (reference outline in the prompt) and
  oracle (full reference patch in the prompt); drift onset is known for the distractor arm
- outcome label: \`reward\` / fail-to-pass fraction from the benchmark grader

${scaffoldSection(scaffold)}

${interventionSection(interventions, runs)}

## Per-arm summary (default heuristic: weights ${JSON.stringify(DEFAULT_WEIGHTS)}, sensitivity ${DEFAULT_SENSITIVITY}, threshold ${WARN_THRESHOLD})

${armSummary(runs, defaultParams)}

## Runs (default heuristic: weights ${JSON.stringify(DEFAULT_WEIGHTS)}, sensitivity ${DEFAULT_SENSITIVITY}, threshold ${WARN_THRESHOLD})

${runTable(runs, defaultParams)}

## Early detection

Default heuristic (\`drift.json\` today):

- distractor runs: ${defaultStats.positives}, detected: ${defaultStats.detected} (TPR ${fmt(defaultStats.tpr)})
- non-distractor runs (control/guided/oracle; intervene excluded, its alarms are intentional): ${defaultStats.controls}, false alarms: ${defaultStats.falseAlarms} (FPR ${fmt(defaultStats.fpr)})
- median detection latency: ${fmt(defaultStats.medianLatency, 1)} turns after injection
- outcome AUC (max score over first ${Math.round(outcomeDefault.fraction * 100)}% of turns → eventual failure): ${fmt(outcomeDefault.auc)} (${outcomeDefault.failures} failing / ${outcomeDefault.successes} succeeding)
- Spearman(early max drift, final fail-to-pass fraction): ${fmt(progressDefault.spearman)} across ${progressDefault.n} runs (positive = early drift goes with a worse final score)

Fitted heuristic (grid search: alignment weight 0.50–1.00 step 0.05, sensitivity 1–15, threshold 5–80;
objective: Youden J = TPR − FPR, tie-break on median latency):

- weights ${JSON.stringify(bestParams.weights)}, sensitivity ${bestParams.sensitivity}, threshold ${bestParams.threshold}
- detected: ${bestStats.detected}/${bestStats.positives} (TPR ${fmt(bestStats.tpr)}), false alarms: ${bestStats.falseAlarms}/${bestStats.controls} (FPR ${fmt(bestStats.fpr)})
- median detection latency: ${fmt(bestStats.medianLatency, 1)} turns
- outcome AUC: ${fmt(outcomeBest.auc)} (${outcomeBest.failures} failing / ${outcomeBest.successes} succeeding)
- Spearman(early max drift, final fail-to-pass fraction): ${fmt(progressBest.spearman)}

Parameters fitted for outcome prediction (max early drift over the first
${Math.round(outcomeDefault.fraction * 100)}% of turns as a failure score; failures = reward 0):

- best weights ${JSON.stringify(outcomeFit.best?.weights ?? {})}, sensitivity ${outcomeFit.best?.sensitivity ?? "n/a"} → outcome AUC ${fmt(outcomeFit.best?.outcome.auc ?? Number.NaN)}

${outcomeRows(outcomeFit.rows)}

Natural failures (control arm, reward 0): lead time of the first default-threshold
crossing before the final turn: ${naturalLeads.length ? naturalLeads.join(", ") : "none crossed"}.

Top injection-detection grid candidates:

${topRows(fit.rows)}

## Trajectories (default heuristic)

${trajectorySection(runs, defaultParams)}

## Limits

- Small sample: these numbers are a pilot signal, not a benchmark claim. Detection
  latency is measured against a synthetic off-plan injection for positives; the
  natural-failure column is the honest part and needs more runs.
- Runs execute in a local clone with a local Python environment instead of the
  benchmark's Docker image, so absolute pass rates are not comparable to the
  DeepSWE leaderboard. The grader, tests and repositories are the benchmark's own.
- Laya is a heuristic probe: absolute scores are relative signals, and the fitted
  parameters are only as stable as this sample.
`

const plotFiles = generatePlots()
const plotSection = plotFiles.length
  ? `## Plots

${plotFiles
  .map((name) => {
    const title = name.replace(/\.svg$/, "").replace(/-/g, " ")
    return `### ${title}\n\n![${title}](plots/${name})\n`
  })
  .join("\n")}`
  : ""
if (plotSection) writeFileSync(join(outDir, "report.md"), `${report}\n${plotSection}`)
else writeFileSync(join(outDir, "report.md"), report)

console.log(`runs: ${runs.length}`)
console.log(
  `default  w=${JSON.stringify(DEFAULT_WEIGHTS)} k=${DEFAULT_SENSITIVITY} t=${WARN_THRESHOLD} → TPR=${fmt(defaultStats.tpr)} FPR=${fmt(defaultStats.fpr)} medianLatency=${fmt(defaultStats.medianLatency, 1)} outcomeAUC=${fmt(outcomeDefault.auc)}`,
)
console.log(
  `fitted   w=${JSON.stringify(bestParams.weights)} k=${bestParams.sensitivity} t=${bestParams.threshold} → TPR=${fmt(bestStats.tpr)} FPR=${fmt(bestStats.fpr)} medianLatency=${fmt(bestStats.medianLatency, 1)} outcomeAUC=${fmt(outcomeBest.auc)}`,
)
console.log(
  `outcome  w=${JSON.stringify(outcomeFit.best?.weights ?? {})} k=${outcomeFit.best?.sensitivity ?? "n/a"} → outcomeAUC=${fmt(outcomeFit.best?.outcome.auc ?? Number.NaN)}`,
)
console.log(`alert threshold reference: ${ALERT_THRESHOLD}; report → ${join(outDir, "report.md")}`)
