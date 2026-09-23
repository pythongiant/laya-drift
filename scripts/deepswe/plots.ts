/**
 * Dependency-free SVG plots for the DeepSWE drift experiment. Reads the
 * logged runs and writes experiments/deepswe/analysis/plots/*.svg.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  DEFAULT_SENSITIVITY,
  DEFAULT_WEIGHTS,
  WARN_THRESHOLD,
  detectionStats,
  fitOutcomeParams,
  fitParams,
  series,
} from "./metrics"
import type { Arm, Params, RunLog } from "./metrics"

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "")
const RUNS = join(ROOT, "experiments", "deepswe", "runs")
const OUT = join(ROOT, "experiments", "deepswe", "analysis", "plots")

const COLORS: Record<Arm, string> = {
  control: "#6b7280",
  distractor: "#dc2626",
  guided: "#2563eb",
  oracle: "#16a34a",
  intervene: "#9333ea",
  verify: "#ea580c",
  scaffold: "#0891b2",
  stall: "#b45309",
}
const ARM_ORDER: Arm[] = ["control", "distractor", "guided", "oracle", "intervene", "verify", "scaffold", "stall"]

type Point = { x: number; y: number }

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function svg(width: number, height: number, body: string[]): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="-apple-system, Helvetica, Arial, sans-serif">
<style>text{fill:#111827}.tick{font-size:11px;fill:#4b5563}.label{font-size:12px;fill:#374151}.title{font-size:14px;font-weight:600}.small{font-size:11px;fill:#6b7280}</style>
${body.join("\n")}
</svg>
`
}

function line(x1: number, y1: number, x2: number, y2: number, color: string, width = 1, dash = ""): string {
  const dashAttr = dash ? ` stroke-dasharray="${dash}"` : ""
  return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${color}" stroke-width="${width}"${dashAttr}/>`
}

function rect(x: number, y: number, w: number, h: number, fill: string, stroke = "none", strokeWidth = 0): string {
  return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(0, w).toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`
}

function text(x: number, y: number, value: string, className = "label", anchor = "start"): string {
  return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" class="${className}" text-anchor="${anchor}">${esc(value)}</text>`
}

function polyline(points: Point[], color: string, width = 2): string {
  if (!points.length) return ""
  const d = points
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(" ")
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round"/>`
}

function rotatedText(x: number, y: number, value: string, className = "small"): string {
  return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" class="${className}" text-anchor="middle" transform="rotate(-90 ${x.toFixed(1)} ${y.toFixed(1)})">${esc(value)}</text>`
}

function circle(x: number, y: number, r: number, fill: string, stroke = "none", strokeWidth = 0): string {
  return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`
}

function legend(
  x: number,
  y: number,
  entries: Array<{ label: string; color: string; shape?: "line" | "dot" }>,
  gap = 118,
): string[] {
  return entries.map((entry, index) => {
    const offset = index * gap
    const marker =
      entry.shape === "dot"
        ? circle(x + offset + 6, y - 4, 5, entry.color)
        : line(x + offset, y - 4, x + offset + 14, y - 4, entry.color, 3)
    return marker + text(x + offset + 20, y, entry.label, "label")
  })
}

function frame(x0: number, y0: number, w: number, h: number, yTicks: number[], yMax: number, yLabel: string): string[] {
  const body: string[] = []
  body.push(rect(x0, y0, w, h, "#ffffff", "#e5e7eb", 1))
  for (const tick of yTicks) {
    const y = y0 + h - (tick / yMax) * h
    body.push(line(x0, y, x0 + w, y, "#f3f4f6", 1))
    body.push(text(x0 - 6, y + 4, String(tick), "tick", "end"))
  }
  body.push(text(x0 - 40, y0 - 10, yLabel, "small"))
  return body
}

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

const defaultParams: Params = { weights: DEFAULT_WEIGHTS, sensitivity: DEFAULT_SENSITIVITY, threshold: WARN_THRESHOLD }

// --- 1. per-run trajectories -------------------------------------------------

export function trajectoriesSvg(runs: RunLog[], params: Params, title: string): string {
  const width = 980
  const panelHeight = 168
  const tasks = [...new Set(runs.map((run) => run.task))]
  const height = 64 + tasks.length * (panelHeight + 34)
  const x0 = 64
  const w = width - x0 - 24
  const body: string[] = [text(24, 26, title, "title")]
  body.push(...legend(24, 48, ARM_ORDER.map((arm) => ({ label: arm, color: COLORS[arm] }))))
  tasks.forEach((task, taskIndex) => {
    const y0 = 72 + taskIndex * (panelHeight + 34)
    const maxTurns = Math.max(...runs.filter((run) => run.task === task).map((run) => run.turns.length), 6)
    const xScale = (turn: number): number => x0 + ((turn - 1) / Math.max(1, maxTurns - 1)) * w
    const yScale = (score: number): number => y0 + panelHeight - (score / 100) * panelHeight
    body.push(text(x0, y0 - 10, task, "label"))
    body.push(rotatedText(20, y0 + panelHeight / 2, "drift score"))
    body.push(...frame(x0, y0, w, panelHeight, [0, 20, 40, 60, 80, 100], 100, ""))
    for (let turn = 1; turn <= maxTurns; turn += 1) {
      body.push(text(xScale(turn), y0 + panelHeight + 16, String(turn), "tick", "middle"))
    }
    for (const run of runs.filter((candidate) => candidate.task === task)) {
      const scores = series(run, params.weights, params.sensitivity)
      const points = scores.map((score, index) => ({ x: xScale(index + 1), y: yScale(score) }))
      body.push(polyline(points, COLORS[run.arm], run.arm === "oracle" ? 2.5 : 2))
      if (run.injectAt != null) {
        const injection = run.turns.findIndex((turn) => turn.injected)
        const at = injection >= 0 ? injection + 1 : run.injectAt
        body.push(circle(xScale(at), yScale(scores[injection >= 0 ? injection : run.injectAt] ?? 0), 4, COLORS.distractor))
        body.push(text(xScale(at), y0 + 12, "inject", "small", "middle"))
      }
    }
    if (taskIndex === 0) body.push(text(x0 + w, y0 + panelHeight + 32, "turn", "small", "end"))
  })
  return svg(width, height, body)
}

// --- 2. arm summary ----------------------------------------------------------

function armSummary(runs: RunLog[]): string {
  const width = 980
  const height = 340
  const x0 = 64
  const w = width - x0 - 24
  const body: string[] = [text(24, 26, "Per-arm summary (default heuristic)", "title")]
  body.push(...legend(24, 48, ARM_ORDER.map((arm) => ({ label: arm, color: COLORS[arm] }))))

  const panels = [
    { title: "max drift over the run", value: (run: RunLog): number => Math.max(0, ...series(run, defaultParams.weights, defaultParams.sensitivity)), max: 100 },
    { title: "final fail-to-pass fraction", value: (run: RunLog): number => (run.f2p_total ? (run.f2p_passed ?? 0) / run.f2p_total : 0), max: 1 },
  ]
  panels.forEach((panel, panelIndex) => {
    const y0 = 84 + panelIndex * 150
    const h = 100
    const yScale = (value: number): number => y0 + h - (value / panel.max) * h
    body.push(text(24, y0 - 8, panel.title, "label"))
    body.push(...frame(x0, y0, w, h, panel.max === 1 ? [0, 0.5, 1] : [0, 25, 50, 75, 100], panel.max, ""))
    ARM_ORDER.forEach((arm, armIndex) => {
      const subset = runs.filter((run) => run.arm === arm)
      if (!subset.length) return
      const slot = w / ARM_ORDER.length
      const center = x0 + slot * armIndex + slot / 2
      const mean = subset.reduce((sum, run) => sum + panel.value(run), 0) / subset.length
      body.push(rect(center - 26, yScale(mean), 52, y0 + h - yScale(mean), COLORS[arm], "none"))
      subset.forEach((run, runIndex) => {
        const jitter = ((runIndex % 5) - 2) * 7
        body.push(circle(center + jitter, yScale(panel.value(run)), 3.5, "#111827"))
      })
      body.push(text(center, y0 + h + 18, `${arm} (n=${subset.length})`, "tick", "middle"))
      body.push(text(center, yScale(mean) - 6, panel.max === 1 ? mean.toFixed(2) : mean.toFixed(0), "small", "middle"))
    })
  })
  return svg(width, height, body)
}

// --- 3. early drift vs outcome ----------------------------------------------

function earlyVsOutcome(runs: RunLog[]): string {
  const width = 760
  const height = 440
  const x0 = 64
  const y0 = 80
  const w = width - x0 - 40
  const h = height - y0 - 64
  const body: string[] = [text(24, 26, "Early drift vs final benchmark progress", "title")]
  body.push(...legend(24, 48, ARM_ORDER.map((arm) => ({ label: arm, color: COLORS[arm], shape: "dot" as const }))))
  const xScale = (score: number): number => x0 + (score / 100) * w
  const yScale = (fraction: number): number => y0 + h - fraction * h
  body.push(...frame(x0, y0, w, h, [0, 0.25, 0.5, 0.75, 1], 1, "final f2p fraction"))
  for (const tick of [0, 25, 50, 75, 100]) {
    body.push(text(xScale(tick), y0 + h + 16, String(tick), "tick", "middle"))
  }
  body.push(text(x0 + w / 2, y0 + h + 38, "max drift over first 80% of turns", "label", "middle"))
  runs.forEach((run, index) => {
    const scores = series(run, defaultParams.weights, defaultParams.sensitivity)
    if (!scores.length) return
    const cut = Math.max(1, Math.floor(scores.length * 0.8))
    const early = Math.max(...scores.slice(0, cut))
    const f2p = run.f2p_total ? (run.f2p_passed ?? 0) / run.f2p_total : 0
    const jitter = ((index % 7) - 3) * 0.012
    body.push(circle(xScale(early), yScale(Math.min(1, Math.max(0, f2p + jitter))), 6, COLORS[run.arm], "#ffffff", 1))
  })
  return svg(width, height, body)
}

// --- 4. detection tradeoff ---------------------------------------------------

function detectionTradeoff(runs: RunLog[]): string {
  const width = 760
  const height = 460
  const x0 = 64
  const y0 = 80
  const w = width - x0 - 40
  const h = height - y0 - 64
  const fit = fitParams(runs)
  const body: string[] = [text(24, 26, "Injected-drift detection: every grid candidate", "title")]
  body.push(...legend(24, 48, [
    { label: "candidates (colour = J)", color: "#9ca3af", shape: "dot" as const },
    { label: "fitted best", color: "#dc2626", shape: "dot" as const },
    { label: `default (${DEFAULT_WEIGHTS.alignment}/${DEFAULT_WEIGHTS.plan_ref}, k=${DEFAULT_SENSITIVITY}, t=${WARN_THRESHOLD})`, color: "#111827", shape: "dot" as const },
  ], 230))
  const xScale = (value: number): number => x0 + value * w
  const yScale = (value: number): number => y0 + h - value * h
  body.push(...frame(x0, y0, w, h, [0, 0.25, 0.5, 0.75, 1], 1, "TPR (injected runs detected)"))
  for (const tick of [0, 0.25, 0.5, 0.75, 1]) {
    body.push(text(xScale(tick), y0 + h + 16, tick.toFixed(2), "tick", "middle"))
  }
  body.push(text(x0 + w / 2, y0 + h + 38, "FPR (non-drifted runs alarmed)", "label", "middle"))
  body.push(line(xScale(0), yScale(0), xScale(1), yScale(1), "#d1d5db", 1, "4 4"))
  for (const row of fit.rows) {
    if (Number.isNaN(row.stats.tpr) || Number.isNaN(row.stats.fpr)) continue
    const youden = row.stats.youden
    const intensity = Math.min(1, Math.max(0, (youden + 1) / 2))
    const color = `rgb(${Math.round(156 + 99 * intensity)}, ${Math.round(163 - 80 * intensity)}, ${Math.round(175 - 80 * intensity)})`
    body.push(circle(xScale(row.stats.fpr), yScale(row.stats.tpr), 2.6, color))
  }
  const defaults = detectionStats(runs, defaultParams)
  body.push(circle(xScale(defaults.fpr), yScale(defaults.tpr), 7, "#111827", "#ffffff", 1.5))
  body.push(text(xScale(defaults.fpr), yScale(defaults.tpr) - 12, "default", "small", "middle"))
  if (fit.best && !Number.isNaN(fit.best.stats.tpr) && !Number.isNaN(fit.best.stats.fpr)) {
    body.push(circle(xScale(fit.best.stats.fpr), yScale(fit.best.stats.tpr), 7, "#dc2626", "#ffffff", 1.5))
    body.push(text(xScale(fit.best.stats.fpr), yScale(fit.best.stats.tpr) - 12, "fitted", "small", "middle"))
  }
  return svg(width, height, body)
}

// --- 5. threshold sweep ------------------------------------------------------

function thresholdSweep(runs: RunLog[]): string {
  const width = 980
  const height = 360
  const body: string[] = [text(24, 26, `Threshold sweep at default weights, sensitivity ${DEFAULT_SENSITIVITY}`, "title")]
  body.push(...legend(24, 48, [
    { label: "TPR", color: "#dc2626" },
    { label: "FPR", color: "#6b7280" },
    { label: "median latency (turns)", color: "#2563eb" },
  ]))
  const thresholds = Array.from({ length: 16 }, (_, index) => 5 + index * 5)
  const stats = thresholds.map((threshold) => detectionStats(runs, { ...defaultParams, threshold }))
  const x0 = 64
  const w = width - x0 - 24
  const xScale = (threshold: number): number => x0 + ((threshold - 5) / 75) * w

  const panels = [
    { y0: 76, h: 110, max: 1, label: "rate", values: stats.map((entry) => ({ tpr: entry.tpr, fpr: entry.fpr })) },
    { y0: 224, h: 90, max: Math.max(1, ...stats.map((entry) => (Number.isNaN(entry.medianLatency) ? 0 : entry.medianLatency))), label: "turns", values: null },
  ]
  for (const panel of panels) {
    body.push(...frame(x0, panel.y0, w, panel.h, panel.max === 1 ? [0, 0.5, 1] : [0, Math.round(panel.max)], panel.max, panel.label))
  }
  for (const threshold of thresholds) {
    body.push(text(xScale(threshold), panels[0]!.y0 + panels[0]!.h + 16, String(threshold), "tick", "middle"))
  }
  body.push(text(x0 + w / 2, panels[0]!.y0 + panels[0]!.h + 38, "threshold", "label", "middle"))

  const rateY = (value: number): number => panels[0]!.y0 + panels[0]!.h - (value / 1) * panels[0]!.h
  body.push(polyline(stats.map((entry, index) => ({ x: xScale(thresholds[index]!), y: rateY(entry.tpr) })), "#dc2626", 2.5))
  body.push(polyline(stats.map((entry, index) => ({ x: xScale(thresholds[index]!), y: rateY(entry.fpr) })), "#6b7280", 2.5))
  const latencyY = (value: number): number => panels[1]!.y0 + panels[1]!.h - (value / panels[1]!.max) * panels[1]!.h
  body.push(
    polyline(
      stats.map((entry, index) => ({ x: xScale(thresholds[index]!), y: latencyY(Number.isNaN(entry.medianLatency) ? 0 : entry.medianLatency) })),
      "#2563eb",
      2.5,
    ),
  )
  const marker = (threshold: number, color: string): void => {
    body.push(line(xScale(threshold), panels[0]!.y0, xScale(threshold), panels[1]!.y0 + panels[1]!.h, color, 1.5, "4 4"))
    body.push(text(xScale(threshold), panels[0]!.y0 - 6, `t=${threshold}`, "small", "middle"))
  }
  marker(WARN_THRESHOLD, "#111827")
  return svg(width, height, body)
}

// --- 6. outcome AUC heatmap --------------------------------------------------

function outcomeHeatmap(runs: RunLog[]): string {
  const fit = fitOutcomeParams(runs)
  const alignments = [...new Set(fit.rows.map((row) => row.weights.alignment!))].sort((a, b) => a - b)
  const sensitivities = [...new Set(fit.rows.map((row) => row.sensitivity))].sort((a, b) => a - b)
  const cellW = 62
  const cellH = 24
  const x0 = 110
  const y0 = 72
  const width = x0 + alignments.length * cellW + 24
  const height = y0 + sensitivities.length * cellH + 56
  const body: string[] = [text(24, 26, "Outcome AUC grid (early max drift -> eventual failure)", "title")]
  body.push(text(24, 48, "colour: chance (light) -> perfect (dark); best cell outlined", "small"))
  body.push(text(x0 + (alignments.length * cellW) / 2, y0 - 10, "alignment weight (plan_ref = 1 - alignment)", "label", "middle"))
  const aucValues = fit.rows.map((row) => (Number.isNaN(row.outcome.auc) ? 0 : row.outcome.auc))
  const lo = Math.min(...aucValues)
  const hi = Math.max(...aucValues)
  const colorFor = (auc: number): string => {
    const t = hi === lo ? 0 : Math.min(1, Math.max(0, (auc - lo) / (hi - lo)))
    const from = [219, 234, 254]
    const to = [185, 28, 28]
    const mix = from.map((value, index) => Math.round(value + (to[index]! - value) * t))
    return `rgb(${mix.join(",")})`
  }
  sensitivities.forEach((sensitivity, rowIndex) => {
    body.push(text(x0 - 10, y0 + rowIndex * cellH + cellH / 2 + 4, `k=${sensitivity}`, "tick", "end"))
  })
  alignments.forEach((alignment, columnIndex) => {
    body.push(text(x0 + columnIndex * cellW + cellW / 2, y0 + sensitivities.length * cellH + 16, alignment.toFixed(2), "tick", "middle"))
  })
  fit.rows.forEach((row) => {
    const column = alignments.indexOf(row.weights.alignment!)
    const line_ = sensitivities.indexOf(row.sensitivity)
    const auc = Number.isNaN(row.outcome.auc) ? 0 : row.outcome.auc
    const isBest = fit.best === row || (fit.best && row.sensitivity === fit.best.sensitivity && row.weights.alignment === fit.best.weights.alignment)
    body.push(rect(x0 + column * cellW, y0 + line_ * cellH, cellW - 2, cellH - 2, colorFor(auc), isBest ? "#111827" : "none", isBest ? 2 : 0))
    body.push(text(x0 + column * cellW + cellW / 2, y0 + line_ * cellH + cellH / 2 + 4, auc.toFixed(2), "tick", "middle"))
  })
  return svg(width, height, body)
}

// --- 7. score distribution by arm -------------------------------------------

function scoreDistribution(runs: RunLog[]): string {
  const width = 760
  const height = 440
  const x0 = 64
  const y0 = 80
  const w = width - x0 - 40
  const h = height - y0 - 64
  const body: string[] = [text(24, 26, "Every scored turn by arm (default heuristic)", "title")]
  body.push(...legend(24, 48, ARM_ORDER.map((arm) => ({ label: arm, color: COLORS[arm], shape: "dot" as const }))))
  const yScale = (score: number): number => y0 + h - (score / 100) * h
  body.push(...frame(x0, y0, w, h, [0, 20, 40, 60, 80, 100], 100, "drift score"))
  body.push(line(x0, yScale(WARN_THRESHOLD), x0 + w, yScale(WARN_THRESHOLD), "#111827", 1, "5 4"))
  body.push(text(x0 + w - 4, yScale(WARN_THRESHOLD) - 5, `warn ${WARN_THRESHOLD}`, "small", "end"))
  const slot = w / ARM_ORDER.length
  ARM_ORDER.forEach((arm, armIndex) => {
    const center = x0 + slot * armIndex + slot / 2
    const scores = runs.filter((run) => run.arm === arm).flatMap((run) => series(run, defaultParams.weights, defaultParams.sensitivity).slice(1))
    scores.forEach((score, index) => {
      const jitter = ((index % 11) - 5) * (slot / 24)
      body.push(circle(center + jitter, yScale(score), 2.4, COLORS[arm]))
    })
    body.push(text(center, y0 + h + 18, `${arm} (${scores.length})`, "tick", "middle"))
  })
  return svg(width, height, body)
}

/** Scaffold arm: drift line plus automatic-verifier outcome markers per turn. */
export function scaffoldChart(runs: RunLog[], params: Params, title: string): string {
  const scaffoldRuns = runs.filter((run) => run.arm === "scaffold")
  const tasks = [...new Set(scaffoldRuns.map((run) => run.task))]
  const width = 980
  const panelHeight = 168
  const height = 64 + Math.max(1, tasks.length) * (panelHeight + 34)
  const x0 = 64
  const w = width - x0 - 24
  const body: string[] = [text(24, 26, title, "title")]
  body.push(text(24, 48, "line = drift score | marker = automatic verifier run (green = all pass, red = failures)", "small"))
  tasks.forEach((task, taskIndex) => {
    const y0 = 72 + taskIndex * (panelHeight + 34)
    const subset = scaffoldRuns.filter((run) => run.task === task)
    const maxTurns = Math.max(...subset.map((run) => run.turns.length), 6)
    const xScale = (turn: number): number => x0 + ((turn - 1) / Math.max(1, maxTurns - 1)) * w
    const yScale = (score: number): number => y0 + panelHeight - (score / 100) * panelHeight
    body.push(text(x0, y0 - 10, task, "label"))
    body.push(rotatedText(20, y0 + panelHeight / 2, "drift score"))
    body.push(...frame(x0, y0, w, panelHeight, [0, 20, 40, 60, 80, 100], 100, ""))
    for (let turn = 1; turn <= maxTurns; turn += 1) {
      body.push(text(xScale(turn), y0 + panelHeight + 16, String(turn), "tick", "middle"))
    }
    for (const run of subset) {
      const scores = series(run, params.weights, params.sensitivity)
      body.push(polyline(scores.map((score, index) => ({ x: xScale(index + 1), y: yScale(score) })), COLORS.scaffold, 2.5))
      for (const verification of run.verifications ?? []) {
        const color = verification.failed === 0 && verification.passed > 0 ? "#16a34a" : "#dc2626"
        const y = yScale(scores[Math.min(verification.turn - 1, scores.length - 1)] ?? 0)
        body.push(circle(xScale(verification.turn), y, 6, color, "#ffffff", 1.5))
      }
    }
  })
  return svg(width, height, body)
}

export function generatePlots(): string[] {
  const runs = loadRuns()
  if (!runs.length) return []
  mkdirSync(OUT, { recursive: true })
  const files: Array<[string, string]> = [
    ["trajectories.svg", trajectoriesSvg(runs, defaultParams, "Drift score per turn (default heuristic)")],
    ["arm-summary.svg", armSummary(runs)],
    ["early-vs-outcome.svg", earlyVsOutcome(runs)],
    ["detection-tradeoff.svg", detectionTradeoff(runs)],
    ["threshold-sweep.svg", thresholdSweep(runs)],
    ["outcome-auc-grid.svg", outcomeHeatmap(runs)],
    ["score-distribution.svg", scoreDistribution(runs)],
    ...(runs.some((run) => run.arm === "scaffold")
      ? ([["scaffold-objective-vs-drift.svg", scaffoldChart(runs, defaultParams, "Scaffold arm: drift vs automatic verifier outcomes")]] as Array<[string, string]>)
      : []),
  ]
  for (const [name, content] of files) writeFileSync(join(OUT, name), content)
  return files.map(([name]) => name)
}
