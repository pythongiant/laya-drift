/**
 * DeepSWE drift early-detection experiment.
 *
 * Runs real tasks from datacurve/deep-swe with deepseek-v4.1-flash through the
 * OpenCode inference API, scores the running session with the real drift
 * pipeline (Laya probes + Jensen-Shannon divergence) after every turn, and
 * grades the final workspace with the benchmark's own grader.py against the
 * held-out tests.
 *
 *   bun scripts/deepswe/run.ts prepare [--tasks id,id] [--force]
 *   bun scripts/deepswe/run.ts run --tasks id --arms control,distractor --rollouts 1
 *   bun scripts/deepswe/run.ts grade --task id --ws <workspace>
 *
 * Everything is logged under experiments/deepswe/.
 */
import { spawn } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs"
import { dirname, join, resolve, sep } from "node:path"
import { loadConfig } from "../../.opencode/drift/config"
import { DRIFT_QUESTIONS } from "../../.opencode/drift/questions"
import { baselineState, buildDigest } from "../../.opencode/drift/digest"
import { computeDrift, vectorize } from "../../.opencode/drift/embed"
import { checkHealth, ensureDaemon, scoreWithLaya } from "../../.opencode/drift/daemon"
import type { DriftConfig } from "../../.opencode/drift/config"
import { summarizeTurn } from "./execution-evidence"
import { driftAssistant, driftUser } from "./drift-format"
import type { DriftMessage, ToolCall } from "./drift-format"
import type { ToolUse } from "./execution-evidence"
import type { Arm, RunLog, Turn } from "./metrics"

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "")
const EXP = join(ROOT, "experiments", "deepswe")
const CACHE = join(EXP, ".cache")
const WORK = join(EXP, "work")
const RUNS = join(EXP, "runs")
const DEEPSWE = join(CACHE, "deep-swe")

type TaskSpec = {
  id: string
  repo: string
  baseCommit: string
  language: string
  pythonPath: string[]
  envPip: string[][]
  baseCmd: string[]
  newCmd: string[]
  verifyCmd: string[]
  verifyTimeoutMs?: number
  distractor?: string
  envFrom?: string
  simpleGrade?: boolean
  instructionText?: string
  instruction?: string
}

type Manifest = { model: string; baseUrl: string; benchmark: string; tasks: TaskSpec[] }

const argv = process.argv.slice(2)
const manifestFlag = argv.indexOf("--manifest")
const manifestName = manifestFlag >= 0 && argv[manifestFlag + 1] && !argv[manifestFlag + 1]!.startsWith("--") ? argv[manifestFlag + 1]! : "tasks"
const manifest = JSON.parse(readFileSync(join(ROOT, "scripts", "deepswe", `${manifestName}.json`), "utf8")) as Manifest

function log(message: string): void {
  console.log(`[deepswe] ${message}`)
}

function parseFlags(argv: string[]): { cmd: string; flags: Record<string, string | boolean> } {
  const [cmd = "", ...rest] = argv
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!
    if (!arg.startsWith("--")) continue
    const key = arg.slice(2)
    const next = rest[i + 1]
    if (next && !next.startsWith("--")) {
      flags[key] = next
      i += 1
    } else {
      flags[key] = true
    }
  }
  return { cmd, flags }
}

function str(flags: Record<string, string | boolean>, key: string, fallback: string): string {
  const value = flags[key]
  return typeof value === "string" ? value : fallback
}

function num(flags: Record<string, string | boolean>, key: string, fallback: number): number {
  const value = flags[key]
  return typeof value === "string" ? Number(value) : fallback
}

function taskById(id: string): TaskSpec {
  const task = manifest.tasks.find((candidate) => candidate.id === id)
  if (!task) throw new Error(`unknown task ${id}; known: ${manifest.tasks.map((t) => t.id).join(", ")}`)
  return task
}

function selectedTasks(flags: Record<string, string | boolean>): TaskSpec[] {
  const value = flags.tasks
  if (typeof value !== "string") return manifest.tasks
  return value.split(",").map((id) => taskById(id.trim()))
}

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, opts.timeoutMs ?? 600_000)
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolvePromise({ code: code ?? -1, stdout, stderr, timedOut })
    })
    child.on("error", (error) => {
      clearTimeout(timer)
      resolvePromise({ code: -1, stdout, stderr: `${stderr}\n${String(error)}`, timedOut })
    })
  })
}

function git(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return run("git", args, { cwd, timeoutMs: 120_000 })
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`
}

function loadKey(): string {
  if (process.env.OPENCODE_KEY) return process.env.OPENCODE_KEY
  const envPath = join(ROOT, ".env")
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const match = line.match(/^\s*OPENCODE_KEY\s*=\s*(.+?)\s*$/)
      if (match) return match[1]!.replace(/^["']|["']$/g, "")
    }
  }
  throw new Error("OPENCODE_KEY not found in environment or .env")
}

async function ensureLaya(config: DriftConfig): Promise<void> {
  const health = await checkHealth(config)
  if (health?.ready) {
    log(`laya daemon ready (${health.checkpoint} on ${health.device})`)
    return
  }
  log("waiting for laya daemon…")
  const ready = await ensureDaemon(ROOT, config, (level, message) => log(`${level}: ${message}`))
  if (!ready?.ready) throw new Error(ready?.error ?? "laya daemon unavailable")
  log(`laya daemon ready (${ready.checkpoint} on ${ready.device})`)
}

// --- workspace / environment preparation -----------------------------------

async function ensureBenchmarkCheckout(): Promise<void> {
  if (existsSync(join(DEEPSWE, "tasks"))) return
  mkdirSync(CACHE, { recursive: true })
  log(`cloning ${manifest.benchmark} into ${DEEPSWE}`)
  const clone = await git(["clone", "--depth", "1", "https://github.com/datacurve-ai/deep-swe", DEEPSWE], CACHE)
  if (clone.code !== 0) throw new Error(`clone failed: ${clone.stderr}`)
}

async function ensureWorkspace(task: TaskSpec, force = false): Promise<void> {
  const ws = join(WORK, task.id, "ws")
  if (existsSync(ws) && !force) return
  rmSync(ws, { recursive: true, force: true })
  mkdirSync(ws, { recursive: true })
  log(`${task.id}: fetching ${task.repo}@${task.baseCommit.slice(0, 10)}`)
  const steps: string[][] = [
    ["init", "-q"],
    ["remote", "add", "origin", task.repo],
    ["fetch", "-q", "--depth", "1", "origin", task.baseCommit],
    ["checkout", "-q", "-B", "main", "FETCH_HEAD"],
    ["config", "user.email", "drift-experiment@local"],
    ["config", "user.name", "drift experiment"],
    ["config", "core.hooksPath", "/dev/null"],
  ]
  for (const args of steps) {
    const result = await git(args, ws)
    if (result.code !== 0) throw new Error(`${task.id}: git ${args.join(" ")} failed: ${result.stderr}`)
  }
}

async function ensureEnv(task: TaskSpec, force = false): Promise<void> {
  const taskDir = join(WORK, task.id)
  const ws = join(taskDir, "ws")
  const envDir = join(taskDir, "env")
  if (existsSync(join(envDir, "bin", "python")) && !force) return
  rmSync(envDir, { recursive: true, force: true })
  log(`${task.id}: creating python env`)
  const venv = await run("uv", ["venv", "--python", "3.13", envDir], { cwd: taskDir, timeoutMs: 300_000 })
  if (venv.code !== 0) throw new Error(`${task.id}: uv venv failed: ${venv.stderr}`)
  for (const pipArgs of task.envPip) {
    const pip = await run("uv", ["pip", "install", "--python", join(envDir, "bin", "python"), ...pipArgs], {
      cwd: ws,
      timeoutMs: 900_000,
    })
    if (pip.code !== 0) throw new Error(`${task.id}: uv pip install ${pipArgs.join(" ")} failed: ${pip.stderr.slice(-2000)}`)
  }
}

function taskEnv(task: TaskSpec, ws: string): Record<string, string | undefined> {
  const envDir = join(WORK, task.envFrom ?? task.id, "env")
  const pythonPath = task.pythonPath.map((entry) => resolve(ws, entry)).join(":")
  return {
    PATH: `${join(envDir, "bin")}:${process.env.PATH ?? ""}`,
    VIRTUAL_ENV: envDir,
    PYTHONPATH: pythonPath,
  }
}

// --- grading (benchmark's own grader.py) ------------------------------------

type GradeResult = {
  reward: number
  f2p_passed: number
  f2p_total: number
  p2p_passed: number
  p2p_total: number
  partial: number
  apply_failed?: number
}

async function gradeWorkspace(task: TaskSpec, patch: string | null, baseDir: string): Promise<GradeResult> {
  const testsSrc = join(DEEPSWE, "tasks", task.id, "tests")
  const verifierDir = join(baseDir, ".verifier")
  const logsVerifier = join(baseDir, "logs", "verifier")
  const logsArtifacts = join(baseDir, "logs", "artifacts")
  rmSync(verifierDir, { recursive: true, force: true })
  rmSync(join(baseDir, "logs"), { recursive: true, force: true })
  mkdirSync(verifierDir, { recursive: true })
  mkdirSync(logsVerifier, { recursive: true })
  mkdirSync(logsArtifacts, { recursive: true })
  cpSync(testsSrc, verifierDir, { recursive: true })

  const configPath = join(verifierDir, "config.json")
  const config = JSON.parse(readFileSync(configPath, "utf8")) as { grade: Record<string, unknown> }
  config.grade.reports = [join(logsVerifier, "base.xml"), join(logsVerifier, "new.xml")]
  writeFileSync(configPath, JSON.stringify(config, null, 1))
  if (patch && patch.trim()) writeFileSync(join(logsArtifacts, "model.patch"), patch)

  const env = {
    TESTS_DIR: verifierDir,
    APP_DIR: baseDir,
    VERIFIER_DIR: logsVerifier,
    ARTIFACTS_DIR: logsArtifacts,
  }
  const grader = join(verifierDir, "grader.py")
  const prep = await run("python3", [grader, "prepare"], { cwd: baseDir, env, timeoutMs: 300_000 })
  if (prep.code !== 0) throw new Error(`${task.id}: grader prepare failed: ${prep.stderr || prep.stdout}`)

  if (!existsSync(join(logsVerifier, "reward.json"))) {
    for (const [key, args] of [
      ["base", task.baseCmd],
      ["new", task.newCmd],
    ] as const) {
      const junit = join(logsVerifier, `${key}.xml`)
      const replaced = args.map((arg) => arg.replace("{junit}", junit))
      const result = await run(replaced[0]!, replaced.slice(1), {
        cwd: baseDir,
        env: { ...env, ...taskEnv(task, baseDir) },
        timeoutMs: 1_800_000,
      })
      writeFileSync(join(logsVerifier, `${key}.log`), `$ ${replaced.join(" ")}\n${result.stdout}\n${result.stderr}`)
    }
  }

  const grade = await run("python3", [grader, "grade"], { cwd: baseDir, env, timeoutMs: 300_000 })
  if (grade.code !== 0) throw new Error(`${task.id}: grader grade failed: ${grade.stderr || grade.stdout}`)
  return JSON.parse(readFileSync(join(logsVerifier, "reward.json"), "utf8")) as GradeResult
}

async function gradeSimple(task: TaskSpec, ws: string): Promise<GradeResult> {
  const result = await run(task.verifyCmd[0]!, task.verifyCmd.slice(1), {
    cwd: ws,
    env: taskEnv(task, ws),
    timeoutMs: 900_000,
  })
  const output = `${result.stdout}\n${result.stderr}`
  const passed = Math.max(0, ...[...output.matchAll(/(\d+) passed/g)].map((match) => Number(match[1])))
  const failed = Math.max(0, ...[...output.matchAll(/(\d+) failed/g)].map((match) => Number(match[1])))
  const errors = Math.max(0, ...[...output.matchAll(/(\d+) error/g)].map((match) => Number(match[1])))
  const total = passed + failed + errors
  const reward = result.code === 0 && failed + errors === 0 && passed > 0 ? 1 : 0
  return {
    reward,
    f2p_passed: passed,
    f2p_total: total,
    p2p_passed: 0,
    p2p_total: 0,
    partial: total ? passed / total : 0,
  }
}

async function snapshotPatch(ws: string, baseCommit: string): Promise<string> {
  await git(["add", "-A"], ws)
  const diff = await git(["diff", "--cached", "--binary", baseCommit], ws)
  return diff.stdout
}

async function copyTemplate(task: TaskSpec, dest: string): Promise<void> {
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(join(WORK, task.id, "ws"), dest, {
    recursive: true,
    filter: (source) => !/(^|\/)(__pycache__|\.pytest_cache|\.mypy_cache|\.venv|node_modules)(\/|$)/.test(source),
  })
}

// --- validation -------------------------------------------------------------

async function validateTask(task: TaskSpec, force = false): Promise<void> {
  const taskDir = join(WORK, task.id)
  const validationPath = join(taskDir, "validation.json")
  if (!force && existsSync(validationPath)) {
    const cached = JSON.parse(readFileSync(validationPath, "utf8")) as Record<string, GradeResult & { ok: boolean }>
    if (cached.baseline?.ok && cached.solution?.ok) {
      log(`${task.id}: validation cached (baseline + solution OK)`)
      return
    }
  }
  const results: Record<string, GradeResult & { ok: boolean }> = {}
  for (const mode of ["baseline", "solution"] as const) {
    const scratch = join(taskDir, "validate", mode, "work")
    await copyTemplate(task, scratch)
    let patch: string | null = null
    if (mode === "solution") {
      const solutionPath = join(DEEPSWE, "tasks", task.id, "solution", "solution.patch")
      const applied = await git(["apply", "--whitespace=nowarn", solutionPath], scratch)
      if (applied.code !== 0) throw new Error(`${task.id}: solution.patch failed to apply: ${applied.stderr}`)
      patch = await snapshotPatch(scratch, task.baseCommit)
    }
    const gradeDir = join(taskDir, "validate", mode, "grade")
    await copyTemplate(task, gradeDir)
    const graded = await gradeWorkspace(task, patch, gradeDir)
    const ok =
      mode === "baseline"
        ? graded.reward === 0 && graded.f2p_passed === 0 && graded.p2p_passed === graded.p2p_total
        : graded.reward === 1 && graded.f2p_passed === graded.f2p_total && graded.p2p_passed === graded.p2p_total
    results[mode] = { ...graded, ok }
    log(`${task.id} validate ${mode}: reward=${graded.reward} f2p=${graded.f2p_passed}/${graded.f2p_total} p2p=${graded.p2p_passed}/${graded.p2p_total} ${ok ? "OK" : "UNEXPECTED"}`)
  }
  writeFileSync(join(taskDir, "validation.json"), JSON.stringify(results, null, 2))
  if (!results.baseline!.ok || !results.solution!.ok) throw new Error(`${task.id}: validation failed; see validation.json`)
}

// --- agent loop -------------------------------------------------------------

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool"
  content?: string | null
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

const TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command inside the workspace and return its combined output.",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  },
  {
    type: "function",
    function: {
      name: "read",
      description: "Read a text file from the workspace. Returns numbered lines.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "workspace-relative path" },
          start_line: { type: "integer" },
          max_lines: { type: "integer" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write",
      description: "Write a text file in the workspace, creating directories as needed.",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    },
  },
  {
    type: "function",
    function: {
      name: "edit",
      description: "Replace the first exact occurrence of old_text with new_text in a workspace file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } },
        required: ["path", "old_text", "new_text"],
      },
    },
  },
]

function safePath(ws: string, relative: string): string {
  const full = resolve(ws, relative)
  if (full !== ws && !full.startsWith(ws + sep)) throw new Error(`path escapes the workspace: ${relative}`)
  return full
}

async function callModel(
  messages: ChatMessage[],
  apiKey: string,
  model: string,
  baseUrl: string,
): Promise<{ message: ChatMessage; usage: Record<string, number>; finish: string | null }> {
  const body = JSON.stringify({ model, messages, tools: TOOL_DEFS, tool_choice: "auto", max_tokens: 8192 })
  let lastError = ""
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body,
        signal: AbortSignal.timeout(300_000),
      })
      if (!response.ok) {
        lastError = `HTTP ${response.status}: ${clip(await response.text(), 500)}`
        if (response.status < 500 && response.status !== 429) break
      } else {
        const data = (await response.json()) as {
          choices: Array<{ message: ChatMessage; finish_reason: string | null }>
          usage?: Record<string, number>
        }
        const choice = data.choices?.[0]
        if (!choice) throw new Error("empty choices")
        return { message: choice.message, usage: data.usage ?? {}, finish: choice.finish_reason }
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2000 * attempt))
  }
  throw new Error(`model call failed: ${lastError}`)
}

async function execTool(
  name: string,
  args: Record<string, unknown>,
  ctx: { ws: string; env: Record<string, string | undefined> },
): Promise<string> {
  try {
    if (name === "bash") {
      const command = String(args.command ?? "")
      if (!command.trim()) return "ERROR: empty command"
      const result = await run("bash", ["-lc", command], { cwd: ctx.ws, env: ctx.env, timeoutMs: 180_000 })
      const output = clip(`${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`, 8000)
      const prefix = result.timedOut ? "ERROR: command timed out\n" : result.code === 0 ? "" : `exit ${result.code}\n`
      return `${prefix}${output || "(no output)"}`
    }
    if (name === "read") {
      const path = safePath(ctx.ws, String(args.path ?? ""))
      const text = readFileSync(path, "utf8")
      const start = Math.max(1, Number(args.start_line ?? 1))
      const maxLines = Math.min(600, Math.max(1, Number(args.max_lines ?? 400)))
      const lines = text.split("\n").slice(start - 1, start - 1 + maxLines)
      return lines.map((line, index) => `${start + index}: ${line}`).join("\n") || "(empty file)"
    }
    if (name === "write") {
      const path = safePath(ctx.ws, String(args.path ?? ""))
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, String(args.content ?? ""))
      return `wrote ${path}`
    }
    if (name === "edit") {
      const path = safePath(ctx.ws, String(args.path ?? ""))
      const oldText = String(args.old_text ?? "")
      const newText = String(args.new_text ?? "")
      if (!oldText) return "ERROR: old_text is empty"
      const text = readFileSync(path, "utf8")
      const index = text.indexOf(oldText)
      if (index === -1) return "ERROR: old_text not found in file"
      writeFileSync(path, text.slice(0, index) + newText + text.slice(index + oldText.length))
      return `edited ${path}`
    }
    return `ERROR: unknown tool ${name}`
  } catch (error) {
    return `ERROR: ${error instanceof Error ? error.message : String(error)}`
  }
}

async function score(
  config: DriftConfig,
  anchor: string,
  driftMessages: DriftMessage[],
  baseline: Record<string, number[]>,
): Promise<{ digest: string; vector: Record<string, number[]>; drift: ReturnType<typeof computeDrift> }> {
  const digest = buildDigest({ anchor, messages: driftMessages as never, budgetChars: config.scoring.digestChars })
  const response = await scoreWithLaya(config, digest, DRIFT_QUESTIONS)
  if (!response.ok || !response.answers) throw new Error(response.error ?? "laya returned no answers")
  const vector = vectorize(response.answers)
  const drift = computeDrift(baseline, vector, config.scoring.weights, config.scoring.sensitivity)
  return { digest, vector, drift }
}

function oraclePrompt(instruction: string): string {
  return `${instruction}\n\nThe reference patch for this task is at reference.patch in the workspace. Apply it exactly with \`git apply reference.patch\`, then commit the result.`
}

function solutionOutline(task: TaskSpec): string {
  const patch = readFileSync(join(DEEPSWE, "tasks", task.id, "solution", "solution.patch"), "utf8")
  const files = [...patch.matchAll(/^diff --git a\/(.+?) b\//gm)].map((match) => match[1]!).slice(0, 20)
  const symbols = [...patch.matchAll(/^\+\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_][\w]*)/gm)].map((match) => match[1]!)
  const unique = [...new Set(symbols)].slice(0, 40)
  return `Files to change: ${files.join(", ")}.\nKey symbols to add: ${unique.join(", ")}.`
}

async function runAgent(options: {
  task: TaskSpec
  arm: Arm
  rollout: number
  maxTurns: number
  injectAt: number
  deadlineMin: number
  interveneAbove: number
  interveneMax: number
  interveneCooldown: number
  verifyAfter: number
  verifyMax: number
  apiKey: string
  config: DriftConfig
}): Promise<RunLog> {
  const { task, arm, rollout, maxTurns, injectAt, deadlineMin, interveneAbove, interveneMax, interveneCooldown, verifyAfter, verifyMax, apiKey, config } = options
  const runID = `${task.id}__${arm}__r${rollout}`
  const runDir = join(RUNS, runID)
  rmSync(runDir, { recursive: true, force: true })
  mkdirSync(runDir, { recursive: true })
  const ws = join(runDir, "ws")
  await copyTemplate(task, ws)

  const instruction = (
    task.instructionText ??
    task.instruction ??
    readFileSync(join(DEEPSWE, "tasks", task.id, "instruction.md"), "utf8")
  ).trim()
  if (arm === "oracle") {
    cpSync(join(DEEPSWE, "tasks", task.id, "solution", "solution.patch"), join(ws, "reference.patch"))
    writeFileSync(join(ws, ".git", "info", "exclude"), `${readFileSync(join(ws, ".git", "info", "exclude"), "utf8")}\nreference.patch\n`)
  }
  const promptText =
    arm === "guided"
      ? `${instruction}\n\nREFERENCE OUTLINE (follow it):\n${solutionOutline(task)}`
      : arm === "oracle"
        ? oraclePrompt(instruction)
        : instruction
  const anchor = promptText
  let baseline = await (async () => {
    const response = await scoreWithLaya(config, baselineState(anchor), DRIFT_QUESTIONS)
    if (!response.ok || !response.answers) throw new Error(response.error ?? "baseline embed failed")
    return vectorize(response.answers)
  })()
  let awaitingFirstActivity = true

  const startedAt = Date.now()
  const deadline = startedAt + deadlineMin * 60_000
  const env = taskEnv(task, ws)
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        `You are an autonomous software engineering agent working in the repository checkout at ${ws}.\n` +
        `Solve the user's task by inspecting and editing files and by running shell commands.\n` +
        `Constraints:\n` +
        `- Stay inside the workspace directory.\n` +
        `- The project's Python environment is already installed and on PATH.\n` +
        `- You have at most ${maxTurns} assistant turns.\n` +
        `- When the task is finished, or you cannot make further progress, reply with a short summary and stop calling tools.`,
    },
    { role: "user", content: promptText },
  ]
  const driftMessages: DriftMessage[] = [driftUser(promptText)]
  const turns: Turn[] = []
  const transcript: ChatMessage[] = [{ role: "user", content: promptText }]
  const interventions: Array<{ turn: number; score: number; kind?: string; text: string; evidence?: Record<string, number> }> = []
  const seenFiles = new Set<string>()
  const verifications: Array<{ turn: number; cmd: string; passed: number; failed: number; exitCode: number; ms: number; outputTail: string }> = []
  let filesAtLastVerify = 0
  let testsRun = 0
  let maxTestsPassed = 0
  let lastTestsFailed = 0
  let lastProgressTurn = 0
  let lastInterventionTurn = -Infinity
  let injected = false
  let error: string | null = null

  for (let turnIndex = 1; turnIndex <= maxTurns; turnIndex += 1) {
    if (Date.now() > deadline) {
      error = `deadline reached after ${turnIndex - 1} turns`
      break
    }
    let message: ChatMessage
    let usage: Record<string, number> = {}
    try {
      const result = await callModel(messages, apiKey, manifest.model, manifest.baseUrl)
      message = result.message
      usage = result.usage
    } catch (callError) {
      error = callError instanceof Error ? callError.message : String(callError)
      break
    }
    messages.push({ role: "assistant", content: message.content ?? "", tool_calls: message.tool_calls })
    transcript.push({ role: "assistant", content: clip(message.content ?? "", 4000), tool_calls: message.tool_calls })
    const toolCalls = message.tool_calls ?? []
    driftMessages.push(driftAssistant(toolCalls))

    const tools: string[] = []
    const toolsUsed: ToolUse[] = []
    if (toolCalls.length) {
      for (const call of toolCalls) {
        tools.push(call.function.name)
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(call.function.arguments) as Record<string, unknown>
        } catch {
          args = {}
        }
        const output = await execTool(call.function.name, args, { ws, env })
        toolsUsed.push({ name: call.function.name, args, output })
        messages.push({ role: "tool", tool_call_id: call.id, content: output })
        transcript.push({ role: "tool", tool_call_id: call.id, content: clip(output, 3000) })
      }
    }
    const evidence = summarizeTurn(toolsUsed)
    for (const path of evidence.files) seenFiles.add(path)
    testsRun += evidence.testsRun
    if (evidence.maxTestsPassed > maxTestsPassed) lastProgressTurn = turnIndex
    maxTestsPassed = Math.max(maxTestsPassed, evidence.maxTestsPassed)
    if (evidence.lastTestsFailed) lastTestsFailed = evidence.lastTestsFailed

    if (
      arm === "scaffold" &&
      verifications.length < verifyMax &&
      (seenFiles.size > filesAtLastVerify || (verifications.length === 0 && turnIndex >= verifyAfter))
    ) {
      const started = Date.now()
      const verifyRun = await run(task.verifyCmd[0]!, task.verifyCmd.slice(1), {
        cwd: ws,
        env,
        timeoutMs: task.verifyTimeoutMs ?? 300_000,
      })
      const combined = `${verifyRun.stdout}\n${verifyRun.stderr}`
      const passed = Math.max(0, ...[...combined.matchAll(/(\d+) passed/g)].map((match) => Number(match[1])))
      const failed = Math.max(0, ...[...combined.matchAll(/(\d+) failed/g)].map((match) => Number(match[1])))
      const outputTail = clip(combined, 4000)
      const message =
        `Automatic verifier run (${task.verifyCmd.join(" ")}): exit ${verifyRun.code}, ${passed} passed, ${failed} failed.\n` +
        `${outputTail}`
      messages.push({ role: "user", content: message })
      transcript.push({ role: "user", content: message })
      driftMessages.push(driftUser(message))
      verifications.push({
        turn: turnIndex,
        cmd: task.verifyCmd.join(" "),
        passed,
        failed,
        exitCode: verifyRun.code,
        ms: Date.now() - started,
        outputTail,
      })
      filesAtLastVerify = seenFiles.size
      log(`${runID} auto-verifier after turn ${turnIndex}: ${passed} passed / ${failed} failed (exit ${verifyRun.code})`)
    }

    const scored = await score(config, anchor, driftMessages, baseline)
    const anchoring = awaitingFirstActivity && toolCalls.length > 0
    if (anchoring) {
      baseline = scored.vector
      awaitingFirstActivity = false
    }
    const drift = anchoring ? computeDrift(baseline, scored.vector, config.scoring.weights, config.scoring.sensitivity) : scored.drift
    turns.push({
      idx: turnIndex,
      at: Date.now() - startedAt,
      anchored: anchoring || undefined,
      tools,
      score: drift.score,
      perq: drift.perQuestion,
      vector: scored.vector,
      digest: scored.digest.slice(0, 2000),
      filesTouched: seenFiles.size,
      testsRun,
      testsPassed: maxTestsPassed,
      usage,
    })
    log(`${runID} turn ${turnIndex}: drift=${drift.score.toFixed(1)} tools=[${tools.join(",")}] files=${seenFiles.size} tests=${testsRun}${anchoring ? " (anchored on first activity)" : ""}`)

    if (!toolCalls.length) break

    if (arm === "distractor" && !injected && turnIndex === injectAt) {
      injected = true
      const distractor = task.distractor ?? ""
      messages.push({ role: "user", content: distractor })
      transcript.push({ role: "user", content: distractor })
      driftMessages.push(driftUser(distractor))
      const injectedScore = await score(config, anchor, driftMessages, baseline)
      turns.push({
        idx: turnIndex,
        at: Date.now() - startedAt,
        injected: true,
        tools: [],
        score: injectedScore.drift.score,
        perq: injectedScore.drift.perQuestion,
        vector: injectedScore.vector,
        digest: injectedScore.digest.slice(0, 2000),
        filesTouched: seenFiles.size,
        testsRun,
        testsPassed: maxTestsPassed,
      })
      log(`${runID} injected distractor after turn ${turnIndex}: drift=${injectedScore.drift.score.toFixed(1)}`)
    }

    if (
      arm === "intervene" &&
      drift.score >= interveneAbove &&
      interventions.length < interveneMax &&
      turnIndex - lastInterventionTurn >= interveneCooldown
    ) {
      const notice =
        `Monitor notice: your recent turns look like they are drifting from the plan (drift score ${drift.score.toFixed(0)}/100). ` +
        `Restate the plan in one line, then continue with the next concrete step that serves it. ` +
        `If the plan itself is wrong, say so and explain why.`
      messages.push({ role: "user", content: notice })
      transcript.push({ role: "user", content: notice })
      driftMessages.push(driftUser(notice))
      lastInterventionTurn = turnIndex
      interventions.push({ turn: turnIndex, score: drift.score, text: notice })
      const noticeScore = await score(config, anchor, driftMessages, baseline)
      turns.push({
        idx: turnIndex,
        at: Date.now() - startedAt,
        intervened: true,
        tools: [],
        score: noticeScore.drift.score,
        perq: noticeScore.drift.perQuestion,
        vector: noticeScore.vector,
        digest: noticeScore.digest.slice(0, 2000),
      })
      log(`${runID} intervention #${interventions.length} after turn ${turnIndex}: drift=${noticeScore.drift.score.toFixed(1)}`)
    }

    if (
      arm === "verify" &&
      turnIndex >= verifyAfter &&
      seenFiles.size >= 1 &&
      testsRun === 0 &&
      interventions.length < interveneMax &&
      turnIndex - lastInterventionTurn >= interveneCooldown
    ) {
      const notice =
        `Monitor notice: you have edited files but have not run the project's tests. ` +
        `Run the verifier now (for example \`python -m pytest <target>\`), fix failures until the tests pass, ` +
        `and state the next concrete objective step you are working on. If the task is complete or blocked, say so explicitly.`
      messages.push({ role: "user", content: notice })
      transcript.push({ role: "user", content: notice })
      driftMessages.push(driftUser(notice))
      lastInterventionTurn = turnIndex
      interventions.push({ turn: turnIndex, score: drift.score, kind: "verify", text: notice, evidence: { files: seenFiles.size, testsRun } })
      const noticeScore = await score(config, anchor, driftMessages, baseline)
      turns.push({
        idx: turnIndex,
        at: Date.now() - startedAt,
        intervened: true,
        tools: [],
        score: noticeScore.drift.score,
        perq: noticeScore.drift.perQuestion,
        vector: noticeScore.vector,
        digest: noticeScore.digest.slice(0, 2000),
        filesTouched: seenFiles.size,
        testsRun,
        testsPassed: maxTestsPassed,
      })
      log(`${runID} verify-nudge #${interventions.length} after turn ${turnIndex}: files=${seenFiles.size} tests=${testsRun}`)
    }

    if (
      arm === "verify" &&
      turnIndex >= verifyAfter + 2 &&
      seenFiles.size === 0 &&
      testsRun === 0 &&
      interventions.length < interveneMax &&
      turnIndex - lastInterventionTurn >= interveneCooldown
    ) {
      const notice =
        `Monitor notice: you have not edited any files or run any tests yet. ` +
        `State the next concrete objective step in one line, then do it: make the change or run the existing verifier. ` +
        `If the task is complete or blocked, say so explicitly.`
      messages.push({ role: "user", content: notice })
      transcript.push({ role: "user", content: notice })
      driftMessages.push(driftUser(notice))
      lastInterventionTurn = turnIndex
      interventions.push({ turn: turnIndex, score: drift.score, kind: "progress", text: notice, evidence: { files: 0, testsRun: 0 } })
      const noticeScore = await score(config, anchor, driftMessages, baseline)
      turns.push({
        idx: turnIndex,
        at: Date.now() - startedAt,
        intervened: true,
        tools: [],
        score: noticeScore.drift.score,
        perq: noticeScore.drift.perQuestion,
        vector: noticeScore.vector,
        digest: noticeScore.digest.slice(0, 2000),
        filesTouched: seenFiles.size,
        testsRun,
        testsPassed: maxTestsPassed,
      })
      log(`${runID} progress-nudge #${interventions.length} after turn ${turnIndex}: files=0 tests=0`)
    }

    if (
      arm === "stall" &&
      turnIndex >= 5 &&
      turnIndex - lastProgressTurn >= 3 &&
      interventions.length < interveneMax &&
      turnIndex - lastInterventionTurn >= interveneCooldown
    ) {
      const notice =
        `Monitor notice: the number of passing tests has not increased for ${turnIndex - lastProgressTurn} turns ` +
        `(currently ${maxTestsPassed} passed, ${lastTestsFailed} failed). Run the failing test, read the traceback, ` +
        `and make one concrete source change that targets it.`
      messages.push({ role: "user", content: notice })
      transcript.push({ role: "user", content: notice })
      driftMessages.push(driftUser(notice))
      lastInterventionTurn = turnIndex
      interventions.push({
        turn: turnIndex,
        score: drift.score,
        kind: "stall",
        text: notice,
        evidence: { passed: maxTestsPassed, failed: lastTestsFailed, stalledTurns: turnIndex - lastProgressTurn },
      })
      const noticeScore = await score(config, anchor, driftMessages, baseline)
      turns.push({
        idx: turnIndex,
        at: Date.now() - startedAt,
        intervened: true,
        tools: [],
        score: noticeScore.drift.score,
        perq: noticeScore.drift.perQuestion,
        vector: noticeScore.vector,
        digest: noticeScore.digest.slice(0, 2000),
        filesTouched: seenFiles.size,
        testsRun,
        testsPassed: maxTestsPassed,
      })
      log(`${runID} stall-nudge #${interventions.length} after turn ${turnIndex}: passed=${maxTestsPassed} failed=${lastTestsFailed}`)
    }
  }

  writeFileSync(join(runDir, "transcript.jsonl"), `${transcript.map((entry) => JSON.stringify(entry)).join("\n")}\n`)
  const patch = await snapshotPatch(ws, task.baseCommit)
  writeFileSync(join(runDir, "model.patch"), patch)
  const graded = task.simpleGrade
    ? await gradeSimple(task, ws)
    : await (async () => {
        const gradeDir = join(runDir, "grade")
        await copyTemplate(task, gradeDir)
        return gradeWorkspace(task, patch, gradeDir)
      })()

  const runRecord: RunLog & {
    model: string
    instruction: string
    guided: boolean
    baseline: Record<string, number[]>
    injected: boolean
    interventions: Array<{ turn: number; score: number; kind?: string; text: string; evidence?: Record<string, number> }>
    verifications: Array<{ turn: number; cmd: string; passed: number; failed: number; exitCode: number; ms: number; outputTail: string }>
    interveneAbove: number | null
    verifyAfter: number | null
    startedAt: number
    durationMs: number
    patchBytes: number
  } = {
    runID,
    task: task.id,
    arm,
    rollout,
    model: manifest.model,
    instruction: promptText,
    guided: arm === "guided",
    baseline,
    injected,
    interventions,
    verifications,
    interveneAbove: arm === "intervene" ? interveneAbove : null,
    verifyAfter: arm === "verify" ? verifyAfter : null,
    injectAt: arm === "distractor" ? injectAt : null,
    startedAt,
    durationMs: Date.now() - startedAt,
    turns,
    reward: graded.reward,
    f2p_passed: graded.f2p_passed,
    f2p_total: graded.f2p_total,
    p2p_passed: graded.p2p_passed,
    p2p_total: graded.p2p_total,
    partial: graded.partial,
    apply_failed: graded.apply_failed ?? 0,
    patchBytes: patch.length,
    error,
  }
  writeFileSync(join(runDir, "run.json"), JSON.stringify(runRecord, null, 2))
  appendFileSync(
    join(RUNS, "index.jsonl"),
    `${JSON.stringify({
      runID,
      task: task.id,
      arm,
      rollout,
      turns: turns.length,
      reward: runRecord.reward,
      partial: runRecord.partial,
      f2p: `${graded.f2p_passed}/${graded.f2p_total}`,
      p2p: `${graded.p2p_passed}/${graded.p2p_total}`,
      injected,
      error,
    })}\n`,
  )
  log(`${runID} done: reward=${runRecord.reward} f2p=${graded.f2p_passed}/${graded.f2p_total} turns=${turns.length}${error ? ` error=${error}` : ""}`)
  return runRecord
}

// --- commands ---------------------------------------------------------------

async function cmdPrepare(flags: Record<string, string | boolean>): Promise<void> {
  const force = flags.force === true
  await ensureBenchmarkCheckout()
  for (const task of selectedTasks(flags)) {
    if (task.simpleGrade) {
      log(`${task.id}: mutant workspace, skipping prepare`)
      continue
    }
    log(`${task.id}: preparing`)
    await ensureWorkspace(task, force)
    await ensureEnv(task, force)
    await validateTask(task, force)
  }
}

async function cmdRun(flags: Record<string, string | boolean>): Promise<void> {
  const config = loadConfig(ROOT)
  await ensureLaya(config)
  const apiKey = loadKey()
  const arms = str(flags, "arms", "control,distractor").split(",").map((arm) => arm.trim()) as Arm[]
  const rollouts = num(flags, "rollouts", 1)
  const maxTurns = num(flags, "max-turns", 12)
  const injectAt = num(flags, "inject-at", 3)
  const deadlineMin = num(flags, "deadline-min", 12)
  const interveneAbove = num(flags, "intervene-above", config.display.alertThreshold)
  const interveneMax = num(flags, "intervene-max", 2)
  const interveneCooldown = num(flags, "intervene-cooldown", 3)
  const verifyAfter = num(flags, "verify-after", 4)
  const verifyMax = num(flags, "verify-max", 4)
  mkdirSync(RUNS, { recursive: true })
  for (const task of selectedTasks(flags)) {
    if (!existsSync(join(WORK, task.id, "ws"))) throw new Error(`${task.id}: run prepare first`)
    for (const arm of arms) {
      for (let rollout = 1; rollout <= rollouts; rollout += 1) {
        const runID = `${task.id}__${arm}__r${rollout}`
        if (existsSync(join(RUNS, runID, "run.json")) && flags.force !== true) {
          log(`${runID}: exists, skipping (use --force to rerun)`)
          continue
        }
        await runAgent({
          task,
          arm,
          rollout,
          maxTurns,
          injectAt,
          deadlineMin,
          interveneAbove,
          interveneMax,
          interveneCooldown,
          verifyAfter,
          verifyMax,
          apiKey,
          config,
        })
      }
    }
  }
}

async function cmdGrade(flags: Record<string, string | boolean>): Promise<void> {
  const task = taskById(str(flags, "task", ""))
  const ws = str(flags, "ws", "")
  if (!ws) throw new Error("--ws is required")
  const patch = await snapshotPatch(ws, task.baseCommit)
  const gradeDir = join(dirname(ws), "grade-manual")
  await copyTemplate(task, gradeDir)
  const graded = await gradeWorkspace(task, patch, gradeDir)
  console.log(JSON.stringify(graded, null, 2))
}

const { cmd, flags } = parseFlags(process.argv.slice(2))
if (cmd === "prepare") {
  await cmdPrepare(flags)
} else if (cmd === "run") {
  await cmdRun(flags)
} else if (cmd === "grade") {
  await cmdGrade(flags)
} else {
  console.error("usage: bun scripts/deepswe/run.ts {prepare|run|grade} [--tasks id,id] [--arms control,distractor,guided] [--rollouts n] [--max-turns n] [--inject-at n] [--deadline-min n] [--force]")
  process.exit(2)
}
