/**
 * Compare probe sets on the same logged trajectories.
 *
 * Reads each run's reprobe.json (probe vectors produced by reprobe.ts) and
 * scores the identical transcripts with every candidate question set, uniform
 * weights per set. Reports, per set:
 *   - best outcome AUC over the sensitivity grid (overall, returns, hard tasks)
 *   - best detection point (sensitivity, threshold, TPR, FPR, latency)
 * and writes analysis/probe-comparison.{json,md} plus plots.
 *
 *   bun scripts/deepswe/compare-probes.ts
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { jsDivergence } from "../../.opencode/drift/embed"
import { bestOutcomeAuc, detectionStats, fitThreshold } from "./metrics"
import { trajectoriesSvg } from "./plots"
import { probeSet } from "./probes"
import type { Arm, Params, RunLog, Turn } from "./metrics"

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "")
const RUNS = join(ROOT, "experiments", "deepswe", "runs")
const ANALYSIS = join(ROOT, "experiments", "deepswe", "analysis")
const PLOTS = join(ANALYSIS, "plots")

const SENSITIVITIES = [0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20, 30, 50]
const THRESHOLDS = Array.from({ length: 16 }, (_, index) => 5 + index * 5)
const HARD_TASKS = ["mashumaro-flattened-dataclass-fields", "sqlfmt-create-table-ddl-formatting"]
const RETURNS_TASK = "returns-validated-error-accumulation"

type ReprobeFile = {
  runID: string
  checkpoint: string
  turns: number
  digestMatches: number
  digestChecked: number
  sets: Record<string, { vectors: Array<Record<string, number[]>> }>
}

type RunJson = RunLog & { instruction: string; injected: boolean }

function load(): Array<{ run: RunJson; reprobe: ReprobeFile }> {
  const out: Array<{ run: RunJson; reprobe: ReprobeFile }> = []
  for (const entry of readdirSync(RUNS, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("mutant-")) continue
    const runPath = join(RUNS, entry.name, "run.json")
    const reprobePath = join(RUNS, entry.name, "reprobe.json")
    if (!existsSync(runPath) || !existsSync(reprobePath)) continue
    out.push({
      run: JSON.parse(readFileSync(runPath, "utf8")) as RunJson,
      reprobe: JSON.parse(readFileSync(reprobePath, "utf8")) as ReprobeFile,
    })
  }
  return out.sort((a, b) => a.run.runID.localeCompare(b.run.runID))
}

function pseudoRun(entry: { run: RunJson; reprobe: ReprobeFile }, setId: string): RunLog {
  const vectors = entry.reprobe.sets[setId]?.vectors ?? []
  const turns: Turn[] = vectors.map((vector, index) => ({
    idx: index + 1,
    at: entry.run.turns[index]?.at ?? 0,
    injected: entry.run.turns[index]?.injected,
    tools: entry.run.turns[index]?.tools,
    score: 0,
    perq: {},
    vector,
  }))
  return { ...entry.run, turns }
}

function uniformWeights(setId: string): Record<string, number> {
  const questions = probeSet(setId).questions
  return Object.fromEntries(Object.keys(questions).map((id) => [id, 1]))
}

function quantile(values: number[], q: number): number {
  if (!values.length) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))
  return sorted[index]!
}

/** How much the probe distributions move at all, regardless of direction. */
function signalStats(entries: Array<{ reprobe: ReprobeFile }>, setId: string): { medianMax: number; p90Max: number } {
  const perRun = entries.map((entry) => {
    const vectors = entry.reprobe.sets[setId]?.vectors ?? []
    let max = 0
    for (let i = 1; i < vectors.length; i += 1) {
      for (const question of Object.keys(vectors[i]!)) {
        const base = vectors[0]?.[question]
        const current = vectors[i]?.[question]
        if (base && current) max = Math.max(max, jsDivergence(base, current))
      }
    }
    return max
  })
  return { medianMax: quantile(perRun, 0.5), p90Max: quantile(perRun, 0.9) }
}

const entries = load()
if (!entries.length) {
  console.error("no re-probed runs; run bun scripts/deepswe/reprobe.ts first")
  process.exit(1)
}

const setIds = [...new Set(entries.flatMap((entry) => Object.keys(entry.reprobe.sets)))].sort()
const results = setIds.map((setId) => {
  const weights = uniformWeights(setId)
  const runs = entries.map((entry) => pseudoRun(entry, setId))
  const returns = runs.filter((run) => run.task === RETURNS_TASK)
  const hard = runs.filter((run) => HARD_TASKS.includes(run.task))
  const overall = bestOutcomeAuc(runs, weights, SENSITIVITIES)
  const returnsAuc = bestOutcomeAuc(returns, weights, SENSITIVITIES)
  const hardAuc = bestOutcomeAuc(hard, weights, SENSITIVITIES)
  const fit = fitThreshold(runs, weights, SENSITIVITIES, THRESHOLDS)
  const atDefault = detectionStats(runs, { weights, sensitivity: 7, threshold: 35 })
  return { setId, weights, runs, overall, returnsAuc, hardAuc, fit, atDefault, signal: signalStats(entries, setId) }
})

const fmt = (value: number, digits = 3): string => (Number.isFinite(value) ? value.toFixed(digits) : "n/a")
const bestOf = (id: string): (typeof results)[number] => results.find((row) => row.setId === id)!

const summary = {
  generatedAt: new Date().toISOString(),
  runs: entries.length,
  tasks: [...new Set(entries.map((entry) => entry.run.task))],
  sets: results.map((row) => ({
    setId: row.setId,
    label: probeSet(row.setId).label,
    questions: Object.keys(probeSet(row.setId).questions),
    outcomeAuc: {
      overall: { auc: row.overall.auc, sensitivity: row.overall.sensitivity, failures: row.overall.outcome.failures, successes: row.overall.outcome.successes },
      returns: { auc: row.returnsAuc.auc, sensitivity: row.returnsAuc.sensitivity },
      hard: { auc: row.hardAuc.auc, sensitivity: row.hardAuc.sensitivity },
    },
    detection: row.fit.best
      ? {
          sensitivity: row.fit.best.sensitivity,
          threshold: row.fit.best.threshold,
          tpr: row.fit.best.stats.tpr,
          fpr: row.fit.best.stats.fpr,
          medianLatency: row.fit.best.stats.medianLatency,
        }
      : null,
    atDefault: { tpr: row.atDefault.tpr, fpr: row.atDefault.fpr },
    signal: row.signal,
  })),
}
mkdirSync(ANALYSIS, { recursive: true })
mkdirSync(PLOTS, { recursive: true })
writeFileSync(join(ANALYSIS, "probe-comparison.json"), JSON.stringify(summary, null, 2))

// --- markdown ----------------------------------------------------------------

const md: string[] = [
  "# Probe-set comparison (same trajectories, different questions)",
  "",
  `Generated ${summary.generatedAt} · ${entries.length} re-probed runs (transcripts rebuilt, digest match 100%) · uniform weights per set`,
  "",
  "| set | questions | median max divergence | outcome AUC (all) | outcome AUC (returns) | outcome AUC (hard) | best detection (k, t) | TPR | FPR | latency | TPR@7/35 | FPR@7/35 |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
]
for (const row of results) {
  const detection = row.fit.best
  md.push(
    `| ${row.setId} | ${Object.keys(probeSet(row.setId).questions).join(", ")} | ${fmt(row.signal.medianMax)} | ${fmt(row.overall.auc)} (k=${row.overall.sensitivity}) | ${fmt(row.returnsAuc.auc)} | ${fmt(row.hardAuc.auc)} | ${detection ? `${detection.sensitivity}, ${detection.threshold}` : "-"} | ${fmt(detection?.stats.tpr ?? Number.NaN, 2)} | ${fmt(detection?.stats.fpr ?? Number.NaN, 2)} | ${fmt(detection?.stats.medianLatency ?? Number.NaN, 1)} | ${fmt(row.atDefault.tpr, 2)} | ${fmt(row.atDefault.fpr, 2)} |`,
  )
}
md.push("", "![probe outcome AUC](plots/probe-outcome-auc.svg)", "", "![probe detection](plots/probe-detection.svg)")
const bestSet = [...results].sort((a, b) => (b.overall.auc || 0) - (a.overall.auc || 0))[0]
if (bestSet) {
  md.push(
    "",
    `Best overall set: **${bestSet.setId}** (AUC ${fmt(bestSet.overall.auc)} at k=${bestSet.overall.sensitivity}). Same trajectories under that probe set:`,
    "",
    `![probe trajectories ${bestSet.setId}](plots/probe-trajectories-${bestSet.setId}.svg)`,
  )
}
writeFileSync(join(ANALYSIS, "probe-comparison.md"), `${md.join("\n")}\n`)

// --- plots -------------------------------------------------------------------

function barChart(
  groups: Array<{ label: string; values: Array<{ label: string; value: number; color: string }> }>,
  title: string,
): string {
  const width = 980
  const rowHeight = 92
  const height = 70 + groups.length * rowHeight
  const x0 = 170
  const w = width - x0 - 90
  const body: string[] = [`<text x="24" y="26" class="title">${title}</text>`]
  body.push(`<text x="24" y="48" class="small">bar = best outcome AUC over the sensitivity grid (chance 0.5)</text>`)
  const scale = (value: number): number => x0 + ((value - 0.4) / 0.6) * w
  for (let tick = 0.4; tick <= 1.0001; tick += 0.1) {
    body.push(`<line x1="${scale(tick).toFixed(1)}" y1="60" x2="${scale(tick).toFixed(1)}" y2="${70 + groups.length * rowHeight - 20}" stroke="#f3f4f6"/>`)
    body.push(`<text x="${scale(tick).toFixed(1)}" y="${70 + groups.length * rowHeight - 8}" class="tick" text-anchor="middle">${tick.toFixed(1)}</text>`)
  }
  groups.forEach((group, groupIndex) => {
    const y = 70 + groupIndex * rowHeight
    body.push(`<text x="24" y="${y + 18}" class="label">${group.label}</text>`)
    group.values.forEach((value, valueIndex) => {
      const barY = y + valueIndex * 22
      body.push(`<rect x="${x0}" y="${barY}" width="${Math.max(0, scale(value.value) - x0).toFixed(1)}" height="16" fill="${value.color}"/>`)
      body.push(`<text x="${(scale(value.value) + 6).toFixed(1)}" y="${barY + 12}" class="tick">${fmt(value.value)}</text>`)
      body.push(`<text x="${x0 - 8}" y="${barY + 12}" class="tick" text-anchor="end">${value.label}</text>`)
    })
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="-apple-system, Helvetica, Arial, sans-serif">
<style>text{fill:#111827}.tick{font-size:11px;fill:#4b5563}.label{font-size:12px;fill:#374151}.title{font-size:14px;font-weight:600}.small{font-size:11px;fill:#6b7280}</style>
${body.join("\n")}
</svg>
`
}

const SET_COLORS: Record<string, string> = {
  shipped: "#6b7280",
  objective: "#dc2626",
  causal: "#2563eb",
  combined: "#16a34a",
}

const barGroups = results.map((row) => ({
  label: row.setId,
  values: [
    { label: "all", value: row.overall.auc, color: SET_COLORS[row.setId] ?? "#111827" },
    { label: "returns", value: row.returnsAuc.auc, color: SET_COLORS[row.setId] ?? "#111827" },
    { label: "hard tasks", value: row.hardAuc.auc, color: SET_COLORS[row.setId] ?? "#111827" },
  ],
}))
writeFileSync(join(PLOTS, "probe-outcome-auc.svg"), barChart(barGroups, "Outcome AUC by probe set and task group"))

const scatterWidth = 760
const scatterHeight = 460
const scatterX0 = 64
const scatterY0 = 80
const scatterW = scatterWidth - scatterX0 - 40
const scatterH = scatterHeight - scatterY0 - 64
const scatter: string[] = [`<text x="24" y="26" class="title">Detection at each set's best point (FPR vs TPR)</text>`]
scatter.push(`<text x="24" y="48" class="small">best Youden J over sensitivity x threshold, uniform weights</text>`)
const xScale = (value: number): number => scatterX0 + value * scatterW
const yScale = (value: number): number => scatterY0 + scatterH - value * scatterH
scatter.push(`<rect x="${scatterX0}" y="${scatterY0}" width="${scatterW}" height="${scatterH}" fill="#ffffff" stroke="#e5e7eb"/>`)
for (const tick of [0, 0.25, 0.5, 0.75, 1]) {
  scatter.push(`<line x1="${scatterX0}" y1="${yScale(tick)}" x2="${scatterX0 + scatterW}" y2="${yScale(tick)}" stroke="#f3f4f6"/>`)
  scatter.push(`<text x="${scatterX0 - 6}" y="${yScale(tick) + 4}" class="tick" text-anchor="end">${tick.toFixed(2)}</text>`)
  scatter.push(`<text x="${xScale(tick)}" y="${scatterY0 + scatterH + 16}" class="tick" text-anchor="middle">${tick.toFixed(2)}</text>`)
}
scatter.push(`<line x1="${xScale(0)}" y1="${yScale(0)}" x2="${xScale(1)}" y2="${yScale(1)}" stroke="#d1d5db" stroke-dasharray="4 4"/>`)
scatter.push(`<text x="${scatterX0 + scatterW / 2}" y="${scatterY0 + scatterH + 38}" class="label" text-anchor="middle">FPR (non-drifted runs alarmed)</text>`)
const labelStack = new Map<string, number>()
for (const row of results) {
  if (!row.fit.best) continue
  const { fpr, tpr } = row.fit.best.stats
  if (!Number.isFinite(fpr) || !Number.isFinite(tpr)) continue
  const color = SET_COLORS[row.setId] ?? "#111827"
  const key = `${fpr.toFixed(2)}:${tpr.toFixed(2)}`
  const stack = labelStack.get(key) ?? 0
  labelStack.set(key, stack + 1)
  scatter.push(`<circle cx="${xScale(fpr).toFixed(1)}" cy="${yScale(tpr).toFixed(1)}" r="7" fill="${color}" stroke="#ffffff" stroke-width="1.5"/>`)
  scatter.push(`<text x="${(xScale(fpr) + 10).toFixed(1)}" y="${(yScale(tpr) - 2 + stack * 14).toFixed(1)}" class="small">${row.setId}</text>`)
}
writeFileSync(
  join(PLOTS, "probe-detection.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" width="${scatterWidth}" height="${scatterHeight}" viewBox="0 0 ${scatterWidth} ${scatterHeight}" font-family="-apple-system, Helvetica, Arial, sans-serif">
<style>text{fill:#111827}.tick{font-size:11px;fill:#4b5563}.label{font-size:12px;fill:#374151}.title{font-size:14px;font-weight:600}.small{font-size:11px;fill:#6b7280}</style>
${scatter.join("\n")}
</svg>
`,
)

for (const file of readdirSync(PLOTS)) {
  if (/^probe-trajectories-.*\.svg$/.test(file)) rmSync(join(PLOTS, file), { force: true })
}

if (bestSet) {
  const params: Params = {
    weights: bestSet.weights,
    sensitivity: bestSet.overall.sensitivity,
    threshold: bestSet.fit.best?.threshold ?? 35,
  }
  writeFileSync(
    join(PLOTS, `probe-trajectories-${bestSet.setId}.svg`),
    trajectoriesSvg(bestSet.runs, params, `Drift score per turn · ${bestSet.setId} probes (uniform weights, k=${params.sensitivity})`),
  )
}

console.log(`sets: ${setIds.join(", ")} · runs: ${entries.length}`)
for (const row of results) {
  console.log(
    `${row.setId.padEnd(10)} outcomeAUC all=${fmt(row.overall.auc)} returns=${fmt(row.returnsAuc.auc)} hard=${fmt(row.hardAuc.auc)} | best detection k=${row.fit.best?.sensitivity ?? "-"} t=${row.fit.best?.threshold ?? "-"} TPR=${fmt(row.fit.best?.stats.tpr ?? Number.NaN, 2)} FPR=${fmt(row.fit.best?.stats.fpr ?? Number.NaN, 2)}`,
  )
}
console.log(`report → ${join(ANALYSIS, "probe-comparison.md")}`)
