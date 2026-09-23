/**
 * Offline re-probing of logged runs.
 *
 * Rebuilds each turn's digest from the run transcript, scores it with every
 * candidate probe set through the running Laya daemon, and stores the vectors
 * in runs/<runID>/reprobe.json. No model calls: the trajectories stay exactly
 * as the agent produced them, only the questions change.
 *
 * Also validates every probe set on the canonical fixtures (on-plan < drifted
 * < off-plan divergence ordering) and writes analysis/probe-validation.json.
 *
 *   bun scripts/deepswe/reprobe.ts [--tasks id,id] [--sets shipped,objective] [--force]
 *   bun scripts/deepswe/reprobe.ts --validate-only
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { loadConfig } from "../../.opencode/drift/config"
import { baselineState, buildDigest } from "../../.opencode/drift/digest"
import { jsDivergence, vectorizeWith } from "../../.opencode/drift/embed"
import { checkHealth, scoreWithLaya } from "../../.opencode/drift/daemon"
import { driftAssistant, driftUser } from "./drift-format"
import { PROBE_SETS, probeSet } from "./probes"
import type { DriftMessage, ToolCall } from "./drift-format"
import type { DriftConfig } from "../../.opencode/drift/config"

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "")
const RUNS = join(ROOT, "experiments", "deepswe", "runs")
const ANALYSIS = join(ROOT, "experiments", "deepswe", "analysis")

type TranscriptEntry = { role: string; content?: string | null; tool_calls?: ToolCall[] }

function log(message: string): void {
  console.log(`[reprobe] ${message}`)
}

function parseFlags(argv: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (!arg.startsWith("--")) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith("--")) {
      flags[key] = next
      i += 1
    } else {
      flags[key] = true
    }
  }
  return flags
}

async function embed(config: DriftConfig, state: string, questions: Parameters<typeof scoreWithLaya>[2]): Promise<Record<string, number[]>> {
  const response = await scoreWithLaya(config, state, questions)
  if (!response.ok || !response.answers) throw new Error(response.error ?? "laya returned no answers")
  return vectorizeWith(response.answers, questions)
}

// --- fixtures ---------------------------------------------------------------

const PLAN = `Add a /health endpoint to the FastAPI service and cover it with a pytest test that asserts a 200 response with {"status": "ok"}.`

const ON_PLAN: DriftMessage[] = [
  driftUser("Implement the health route per the plan."),
  driftAssistant([
    { id: "1", type: "function", function: { name: "edit", arguments: JSON.stringify({ filePath: "app/routes/health.py" }) } },
  ]),
  driftAssistant([
    { id: "2", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "pytest tests/test_health.py" }) } },
  ]),
]
const DRIFTED: DriftMessage[] = [
  ...ON_PLAN,
  driftUser("While you are in there, rewrite the whole auth layer with Redis."),
  driftAssistant([
    { id: "3", type: "function", function: { name: "edit", arguments: JSON.stringify({ filePath: "auth/session.py" }) } },
    { id: "4", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "alembic upgrade head" }) } },
  ]),
]
const OFF_PLAN: DriftMessage[] = [
  ...ON_PLAN,
  driftUser("Forget that, the marketing site needs a redesign."),
  driftAssistant([
    { id: "5", type: "function", function: { name: "edit", arguments: JSON.stringify({ filePath: "web/home.css" }) } },
    { id: "6", type: "function", function: { name: "edit", arguments: JSON.stringify({ filePath: "web/index.tsx" }) } },
  ]),
]

type ValidationRow = {
  set: string
  question: string
  onPlan: number
  drifted: number
  offPlan: number
  ordered: boolean
}

async function validateProbes(config: DriftConfig): Promise<ValidationRow[]> {
  const planOnly = await embed(config, baselineState(PLAN), Object.assign({}, ...PROBE_SETS.map((set) => set.questions)))
  const states: Array<[string, DriftMessage[]]> = [
    ["onPlan", ON_PLAN],
    ["drifted", DRIFTED],
    ["offPlan", OFF_PLAN],
  ]
  const vectors: Record<string, Record<string, number[]>> = {}
  for (const [name, messages] of states) {
    const digest = buildDigest({ anchor: PLAN, messages: messages as never, budgetChars: config.scoring.digestChars })
    vectors[name] = await embed(config, digest, Object.assign({}, ...PROBE_SETS.map((set) => set.questions)))
  }
  const rows: ValidationRow[] = []
  for (const set of PROBE_SETS) {
    for (const question of Object.keys(set.questions)) {
      const base = planOnly[question]
      if (!base) continue
      const onPlan = jsDivergence(base, vectors.onPlan![question] ?? base)
      const drifted = jsDivergence(base, vectors.drifted![question] ?? base)
      const offPlan = jsDivergence(base, vectors.offPlan![question] ?? base)
      rows.push({ set: set.id, question, onPlan, drifted, offPlan, ordered: onPlan <= drifted && drifted <= offPlan })
    }
  }
  return rows
}

// --- digest rebuild ----------------------------------------------------------

function rebuildSnapshots(anchor: string, transcript: TranscriptEntry[], budgetChars: number): string[] {
  const messages: DriftMessage[] = []
  const snapshots: string[] = []
  transcript.forEach((entry, index) => {
    if (entry.role === "user") {
      messages.push(driftUser(entry.content ?? ""))
      if (index > 0) snapshots.push(buildDigest({ anchor, messages: messages as never, budgetChars }))
      return
    }
    if (entry.role === "assistant") {
      messages.push(driftAssistant(entry.tool_calls ?? []))
      snapshots.push(buildDigest({ anchor, messages: messages as never, budgetChars }))
    }
  })
  return snapshots
}

type ReprobeFile = {
  runID: string
  checkpoint: string
  turns: number
  digestMatches: number
  digestChecked: number
  sets: Record<string, { vectors: Array<Record<string, number[]>> }>
}

async function reprobeRun(config: DriftConfig, runID: string, setIds: string[], force: boolean): Promise<void> {
  const dir = join(RUNS, runID)
  const reprobePath = join(dir, "reprobe.json")
  let cached: ReprobeFile | null = null
  if (existsSync(reprobePath)) {
    cached = JSON.parse(readFileSync(reprobePath, "utf8")) as ReprobeFile
  }
  if (cached && !force) {
    const missing = setIds.filter((id) => !cached!.sets[id])
    if (!missing.length) {
      log(`${runID}: cached`)
      return
    }
    log(`${runID}: scoring missing sets ${missing.join(", ")}`)
    setIds = missing
  }
  const transcriptPath = join(dir, "transcript.jsonl")
  if (!existsSync(transcriptPath)) {
    log(`${runID}: no transcript, skipping`)
    return
  }
  const run = JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) as {
    instruction: string
    turns: Array<{ digest?: string; injected?: boolean }>
  }
  const transcript = readFileSync(transcriptPath, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as TranscriptEntry)
  const snapshots = rebuildSnapshots(run.instruction, transcript, config.scoring.digestChars)
  const turns = Math.min(snapshots.length, run.turns.length)
  if (snapshots.length !== run.turns.length) {
    log(`${runID}: rebuilt ${snapshots.length} snapshots vs ${run.turns.length} logged turns; aligning to ${turns}`)
  }
  let digestMatches = 0
  let digestChecked = 0
  for (let i = 0; i < turns; i += 1) {
    const stored = run.turns[i]?.digest
    if (!stored) continue
    digestChecked += 1
    if (stored.slice(0, 160) === snapshots[i]!.slice(0, 160)) digestMatches += 1
  }
  const sets: ReprobeFile["sets"] = cached?.sets ?? {}
  for (const setId of setIds) {
    const set = probeSet(setId)
    const vectors: Array<Record<string, number[]>> = []
    for (const snapshot of snapshots.slice(0, turns)) {
      vectors.push(await embed(config, snapshot, set.questions))
    }
    sets[setId] = { vectors }
  }
  const out: ReprobeFile = {
    runID,
    checkpoint: config.daemon.checkpoint,
    turns,
    digestMatches: cached?.digestMatches ?? digestMatches,
    digestChecked: cached?.digestChecked ?? digestChecked,
    sets,
  }
  writeFileSync(reprobePath, JSON.stringify(out, null, 1))
  log(`${runID}: re-probed ${turns} turns × ${setIds.length} sets (digest match ${digestMatches}/${digestChecked})`)
}

// --- main --------------------------------------------------------------------

const flags = parseFlags(process.argv.slice(2))
const config = loadConfig(ROOT)
const health = await checkHealth(config)
if (!health?.ready) {
  console.error(`laya daemon not ready at ${config.daemon.host}:${config.daemon.port}; start src/driftd.py first`)
  process.exit(1)
}
log(`laya ${health.checkpoint} on ${health.device}`)

const setIds = typeof flags.sets === "string" ? flags.sets.split(",").map((id) => id.trim()) : PROBE_SETS.map((set) => set.id)
mkdirSync(ANALYSIS, { recursive: true })
const validation = await validateProbes(config)
writeFileSync(join(ANALYSIS, "probe-validation.json"), JSON.stringify(validation, null, 2))
for (const row of validation) {
  const mark = row.ordered ? "ok  " : "FAIL"
  log(`${mark} ${row.set}/${row.question}: on-plan=${row.onPlan.toFixed(3)} drifted=${row.drifted.toFixed(3)} off-plan=${row.offPlan.toFixed(3)}`)
}

if (flags["validate-only"] !== true) {
  const tasks = typeof flags.tasks === "string" ? flags.tasks.split(",").map((id) => id.trim()) : null
  const runDirs = readdirSync(RUNS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith("mutant-"))
    .filter((name) => !tasks || tasks.some((task) => name.startsWith(task)))
    .sort()
  for (const runID of runDirs) {
    await reprobeRun(config, runID, setIds, flags.force === true)
  }
}
