/**
 * Execution-evidence features from logged transcripts.
 *
 * Tests the third follow-up direction: can observable work products (files
 * touched, tests run, repeated commands, errors, stalls) predict eventual
 * failure better than the semantic probe? Pure offline: parses
 * runs/<runID>/transcript.jsonl and model.patch, no model or daemon.
 *
 *   bun scripts/deepswe/evidence.ts
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ERROR_RE, looksLikeTestFile, summarizeTurn } from "./execution-evidence"
import { auc, series, DEFAULT_WEIGHTS, DEFAULT_SENSITIVITY } from "./metrics"
import type { RunLog } from "./metrics"

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "")
const RUNS = join(ROOT, "experiments", "deepswe", "runs")
const ANALYSIS = join(ROOT, "experiments", "deepswe", "analysis")
const PLOTS = join(ANALYSIS, "plots")

type ToolCall = { id?: string; function?: { name?: string; arguments?: string } }
type Entry = { role?: string; content?: string | null; tool_calls?: ToolCall[] }
type ToolUse = { name: string; args: Record<string, unknown>; output: string }
type TurnUse = { tools: ToolUse[] }

function parseTranscript(path: string): TurnUse[] {
  const entries = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Entry)
  const turns: TurnUse[] = []
  let current: TurnUse | null = null
  for (const entry of entries) {
    if (entry.role === "assistant") {
      current = { tools: [] }
      turns.push(current)
      for (const call of entry.tool_calls ?? []) {
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(call.function?.arguments ?? "{}") as Record<string, unknown>
        } catch {
          args = {}
        }
        current.tools.push({ name: call.function?.name ?? "unknown", args, output: "" })
      }
      continue
    }
    if (entry.role === "tool" && current) {
      const pending = current.tools.find((tool) => !tool.output)
      if (pending) pending.output = entry.content ?? ""
    }
  }
  return turns
}

type Features = {
  wroteTests: number
  filesTouched: number
  turnsSinceNewFile: number
  testsRun: number
  maxTestsPassed: number
  lastTestsFailed: number
  errorRate: number
  repeatRatio: number
  maxEditsPerFile: number
  toolCalls: number
}

function extractFeatures(turns: TurnUse[], from: number, to: number): Features {
  const seenFiles = new Set<string>()
  const fileEdits = new Map<string, number>()
  let wroteTests = 0
  const commands: string[] = []
  let newFileTurn = -1
  let testsRun = 0
  let maxTestsPassed = 0
  let lastTestsFailed = 0
  let errors = 0
  let toolCalls = 0
  for (let index = from; index < to; index += 1) {
    const tools = turns[index]?.tools ?? []
    for (const tool of tools) {
      if (tool.name === "bash") {
        const command = String(tool.args.command ?? "").replace(/\s+/g, " ").trim()
        if (command) commands.push(command)
      }
    }
    const evidence = summarizeTurn(tools)
    toolCalls += evidence.toolCalls
    errors += evidence.errors
    for (const path of evidence.files) {
      if (!seenFiles.has(path)) {
        seenFiles.add(path)
        newFileTurn = index
      }
      if (looksLikeTestFile(path)) wroteTests += 1
      fileEdits.set(path, (fileEdits.get(path) ?? 0) + 1)
    }
    testsRun += evidence.testsRun
    maxTestsPassed = Math.max(maxTestsPassed, evidence.maxTestsPassed)
    if (evidence.lastTestsFailed) lastTestsFailed = evidence.lastTestsFailed
  }
  const uniqueCommands = new Set(commands).size
  const span = Math.max(1, to - from)
  return {
    wroteTests,
    filesTouched: seenFiles.size,
    turnsSinceNewFile: newFileTurn < 0 ? span : to - 1 - newFileTurn,
    testsRun,
    maxTestsPassed,
    lastTestsFailed,
    errorRate: toolCalls ? errors / toolCalls : 0,
    repeatRatio: commands.length ? 1 - uniqueCommands / commands.length : 0,
    maxEditsPerFile: fileEdits.size ? Math.max(...fileEdits.values()) : 0,
    toolCalls,
  }
}

type Row = {
  runID: string
  task: string
  arm: string
  reward: number
  f2p: number
  turns: number
  window: number
  features: Features
  full: Features & { everRanTests: boolean }
  semanticEarlyMax: number
  patchLines: number
}

function loadRows(): Row[] {
  const rows: Row[] = []
  for (const entry of readdirSync(RUNS, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("mutant-")) continue
    const dir = join(RUNS, entry.name)
    const transcriptPath = join(dir, "transcript.jsonl")
    const runPath = join(dir, "run.json")
    if (!existsSync(transcriptPath) || !existsSync(runPath)) continue
    const run = JSON.parse(readFileSync(runPath, "utf8")) as RunLog
    const turns = parseTranscript(transcriptPath)
    if (!turns.length) continue
    const window = Math.max(1, Math.floor(turns.length * 0.8))
    const patchPath = join(dir, "model.patch")
    const patchLines = existsSync(patchPath)
      ? readFileSync(patchPath, "utf8").split("\n").filter((line) => line.startsWith("+") || line.startsWith("-")).length
      : 0
    const scores = series(run, DEFAULT_WEIGHTS, DEFAULT_SENSITIVITY)
    rows.push({
      runID: run.runID,
      task: run.task,
      arm: run.arm,
      reward: run.reward,
      f2p: run.f2p_total ? (run.f2p_passed ?? 0) / run.f2p_total : 0,
      turns: turns.length,
      window,
      features: extractFeatures(turns, 0, window),
      full: { ...extractFeatures(turns, 0, turns.length), everRanTests: extractFeatures(turns, 0, turns.length).testsRun > 0 },
      semanticEarlyMax: scores.length ? Math.max(...scores.slice(0, Math.max(1, Math.floor(scores.length * 0.8)))) : 0,
      patchLines,
    })
  }
  return rows.sort((a, b) => a.runID.localeCompare(b.runID))
}

const rows = loadRows()
if (!rows.length) {
  console.error("no transcripts found")
  process.exit(1)
}

type FeatureSpec = { key: keyof Features; label: string; higherMeansFailure: boolean }
const FEATURES: FeatureSpec[] = [
  { key: "turnsSinceNewFile", label: "turns since last new file", higherMeansFailure: true },
  { key: "repeatRatio", label: "repeated-command ratio", higherMeansFailure: true },
  { key: "errorRate", label: "tool error rate", higherMeansFailure: true },
  { key: "maxEditsPerFile", label: "max edits to one file", higherMeansFailure: true },
  { key: "lastTestsFailed", label: "last failing tests", higherMeansFailure: true },
  { key: "filesTouched", label: "files touched", higherMeansFailure: false },
  { key: "testsRun", label: "test runs", higherMeansFailure: false },
  { key: "maxTestsPassed", label: "best passing tests", higherMeansFailure: false },
]

const failures = rows.filter((row) => row.reward === 0)
const successes = rows.filter((row) => row.reward === 1)

type FeatureResult = { key: string; label: string; auc: number; direction: string }
const featureResults: FeatureResult[] = FEATURES.map((spec) => {
  const pos = failures.map((row) => Number(row.features[spec.key]))
  const neg = successes.map((row) => Number(row.features[spec.key]))
  const raw = auc(pos, neg)
  const oriented = spec.higherMeansFailure ? raw : 1 - raw
  return { key: spec.key, label: spec.label, auc: oriented, direction: spec.higherMeansFailure ? "higher" : "lower" }
})

const semanticAuc = (() => {
  const pos = failures.map((row) => row.semanticEarlyMax)
  const neg = successes.map((row) => row.semanticEarlyMax)
  return auc(pos, neg)
})()

// pre-registered combined score: stall + repetition + errors - test activity
function zScores(values: number[]): number[] {
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const sd = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length) || 1
  return values.map((value) => (value - mean) / sd)
}
const combinedRaw = rows.map((row) => {
  return (
    row.features.turnsSinceNewFile * 1.0 +
    row.features.repeatRatio * 3.0 +
    row.features.errorRate * 3.0 -
    row.features.testsRun * 0.5 -
    row.features.maxTestsPassed * 0.05
  )
})
const combinedZ = zScores(combinedRaw)
const combinedAuc = auc(
  combinedZ.filter((_, index) => rows[index]!.reward === 0),
  combinedZ.filter((_, index) => rows[index]!.reward === 1),
)

mkdirSync(ANALYSIS, { recursive: true })
mkdirSync(PLOTS, { recursive: true })
writeFileSync(
  join(ANALYSIS, "evidence-features.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      runs: rows.length,
      failures: failures.length,
      successes: successes.length,
      semanticAuc,
      combinedAuc,
      features: featureResults,
      rows,
    },
    null,
    2,
  ),
)

const fmt = (value: number, digits = 3): string => (Number.isFinite(value) ? value.toFixed(digits) : "n/a")

const md: string[] = [
  "# Execution-evidence features vs semantic drift",
  "",
  `Generated ${new Date().toISOString()} · ${rows.length} runs with transcripts · early window = first 80% of turns`,
  "",
  `Reference: shipped semantic probe early max drift AUC = **${fmt(semanticAuc)}**; pre-registered combined evidence score AUC = **${fmt(combinedAuc)}**.`,
  "",
  "Caveat: every solved run in this corpus is an oracle run (it applies the reference patch), and",
  "only oracle runs execute tests. The perfect test-feature AUC therefore measures the success",
  "mechanism itself, not an independent predictor. Bash-mediated edits (`git apply`, `sed -i`,",
  "redirects) are parsed here, but the structured-tool-only version of this feature missed them",
  "entirely — an action-normalization warning for any evidence layer.",
  "",
  "Selection caveat: the combined score's weights were chosen after inspecting these same runs,",
  "so 0.926 is optimistic. The robust part is univariate: test execution is binary present/absent.",
  "",
  "| run | reward | tests (early) | tests (full) | passed (full) | files (early) | files (full) | patch lines |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ...rows.map(
    (row) =>
      `| ${row.runID} | ${row.reward} | ${row.features.testsRun} | ${row.full.testsRun} | ${row.full.maxTestsPassed} | ${row.features.filesTouched} | ${row.full.filesTouched} | ${row.patchLines} |`,
  ),
  "",
  `Test authoring: ${rows.filter((row) => row.full.wroteTests > 0).length}/${rows.length} runs wrote a test file at all.`,
  "",
  "| feature | direction | outcome AUC |",
  "| --- | --- | --- |",
  ...featureResults
    .sort((a, b) => b.auc - a.auc)
    .map((result) => `| ${result.label} | ${result.direction} = failure | ${fmt(result.auc)} |`),
  "",
  "![evidence AUC](plots/evidence-auc.svg)",
  "",
  "![patch written vs tests executed](plots/evidence-patch-vs-tests.svg)",
  "",
  "Per-run features are in `evidence-features.json`.",
]
writeFileSync(join(ANALYSIS, "evidence.md"), `${md.join("\n")}\n`)

// --- plots -------------------------------------------------------------------

const svgWrap = (width: number, height: number, body: string[]): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="-apple-system, Helvetica, Arial, sans-serif">
<style>text{fill:#111827}.tick{font-size:11px;fill:#4b5563}.label{font-size:12px;fill:#374151}.title{font-size:14px;font-weight:600}.small{font-size:11px;fill:#6b7280}</style>
${body.join("\n")}
</svg>
`

const sortedFeatures = [...featureResults].sort((a, b) => b.auc - a.auc)
const barWidth = 980
const barHeight = 80 + sortedFeatures.length * 30
const barX0 = 230
const barW = barWidth - barX0 - 90
const barScale = (value: number): number => barX0 + ((value - 0.4) / 0.6) * barW
const barBody: string[] = [`<text x="24" y="26" class="title">Outcome AUC: execution evidence vs semantic probe</text>`]
barBody.push(`<text x="24" y="48" class="small">0.5 = chance; dashed line = shipped semantic probe (${fmt(semanticAuc)})</text>`)
for (const tick of [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]) {
  barBody.push(`<line x1="${barScale(tick).toFixed(1)}" y1="60" x2="${barScale(tick).toFixed(1)}" y2="${barHeight - 24}" stroke="#f3f4f6"/>`)
  barBody.push(`<text x="${barScale(tick).toFixed(1)}" y="${barHeight - 10}" class="tick" text-anchor="middle">${tick.toFixed(1)}</text>`)
}
barBody.push(`<line x1="${barScale(semanticAuc).toFixed(1)}" y1="60" x2="${barScale(semanticAuc).toFixed(1)}" y2="${barHeight - 24}" stroke="#111827" stroke-dasharray="4 4"/>`)
sortedFeatures.forEach((feature, index) => {
  const y = 70 + index * 30
  const color = feature.auc >= semanticAuc ? "#16a34a" : "#9ca3af"
  barBody.push(`<rect x="${barX0}" y="${y}" width="${Math.max(0, barScale(feature.auc) - barX0).toFixed(1)}" height="18" fill="${color}"/>`)
  barBody.push(`<text x="${(barScale(feature.auc) + 6).toFixed(1)}" y="${y + 13}" class="tick">${fmt(feature.auc)}</text>`)
  barBody.push(`<text x="${barX0 - 8}" y="${y + 13}" class="tick" text-anchor="end">${feature.label}</text>`)
})
writeFileSync(join(PLOTS, "evidence-auc.svg"), svgWrap(barWidth, barHeight, barBody))

const scatterWidth = 760
const scatterHeight = 440
const scatterX0 = 64
const scatterY0 = 80
const scatterW = scatterWidth - scatterX0 - 40
const scatterH = scatterHeight - scatterY0 - 64
const maxStall = Math.max(1, ...rows.map((row) => row.patchLines))
const maxTests = Math.max(1, ...rows.map((row) => row.full.testsRun))
const xScale = (value: number): number => scatterX0 + (value / maxStall) * scatterW
const yScale = (value: number): number => scatterY0 + scatterH - (value / maxTests) * scatterH
const scatterBody: string[] = [`<text x="24" y="26" class="title">Patch written vs tests executed (full run)</text>`]
scatterBody.push(`<text x="24" y="48" class="small">green = solved, red = failed; bottom-right = code written but never verified</text>`)
scatterBody.push(`<rect x="${scatterX0}" y="${scatterY0}" width="${scatterW}" height="${scatterH}" fill="#ffffff" stroke="#e5e7eb"/>`)
for (let tick = 0; tick <= maxStall; tick += Math.max(1, Math.ceil(maxStall / 5))) {
  scatterBody.push(`<text x="${xScale(tick).toFixed(1)}" y="${scatterY0 + scatterH + 16}" class="tick" text-anchor="middle">${tick}</text>`)
}
for (let tick = 0; tick <= maxTests; tick += Math.max(1, Math.ceil(maxTests / 5))) {
  scatterBody.push(`<line x1="${scatterX0}" y1="${yScale(tick)}" x2="${scatterX0 + scatterW}" y2="${yScale(tick)}" stroke="#f3f4f6"/>`)
  scatterBody.push(`<text x="${scatterX0 - 6}" y="${(yScale(tick) + 4).toFixed(1)}" class="tick" text-anchor="end">${tick}</text>`)
}
scatterBody.push(`<text x="${scatterX0 + scatterW / 2}" y="${scatterY0 + scatterH + 38}" class="label" text-anchor="middle">patch lines added/removed</text>`)
for (const row of rows) {
  const color = row.reward === 1 ? "#16a34a" : "#dc2626"
  scatterBody.push(
    `<circle cx="${xScale(row.patchLines).toFixed(1)}" cy="${yScale(row.full.testsRun).toFixed(1)}" r="6" fill="${color}" fill-opacity="0.75" stroke="#ffffff" stroke-width="1"/>`,
  )
}
writeFileSync(join(PLOTS, "evidence-patch-vs-tests.svg"), svgWrap(scatterWidth, scatterHeight, scatterBody))

console.log(`runs: ${rows.length} (${failures.length} failed / ${successes.length} solved)`)
console.log(`semantic early-drift AUC: ${fmt(semanticAuc)} | combined evidence AUC: ${fmt(combinedAuc)}`)
for (const result of sortedFeatures) console.log(`${result.label.padEnd(26)} AUC=${fmt(result.auc)} (${result.direction} = failure)`)
console.log(`report → ${join(ANALYSIS, "evidence.md")}`)
