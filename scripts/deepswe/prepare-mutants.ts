/**
 * Build the local-verifier micro-benchmark.
 *
 * For each base DeepSWE task: apply the reference solution and its tests, then
 * inject a small regression into a solution line. A mutation is kept only if
 * the target tests then fail while some still pass, so the agent gets a
 * runnable failing test, a real bug, and a measurable pass fraction.
 *
 * Writes workspaces under experiments/deepswe/work/<mutantID>/ws and a manifest
 * at scripts/deepswe/mutants.json (read by run.ts --manifest mutants).
 *
 *   bun scripts/deepswe/prepare-mutants.ts [--per-repo 2] [--force]
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { spawn } from "node:child_process"

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "")
const WORK = join(ROOT, "experiments", "deepswe", "work")
const DEEPSWE = join(ROOT, "experiments", "deepswe", ".cache", "deep-swe")
const TASKS_FILE = join(ROOT, "scripts", "deepswe", "tasks.json")
const MUTANTS_FILE = join(ROOT, "scripts", "deepswe", "mutants.json")

type BaseTask = {
  id: string
  repo: string
  baseCommit: string
  pythonPath: string[]
  newCmd: string[]
}

const baseManifest = JSON.parse(readFileSync(TASKS_FILE, "utf8")) as { tasks: BaseTask[] }
const REPOS = [
  "mashumaro-flattened-dataclass-fields",
  "sqlfmt-create-table-ddl-formatting",
  "returns-validated-error-accumulation",
]

function log(message: string): void {
  console.log(`[mutants] ${message}`)
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

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 300_000)
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()))
    child.on("close", (code) => {
      clearTimeout(timer)
      resolvePromise({ code: code ?? -1, stdout, stderr })
    })
    child.on("error", (error) => {
      clearTimeout(timer)
      resolvePromise({ code: -1, stdout, stderr: `${stderr}\n${String(error)}` })
    })
  })
}

function git(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return run("git", args, { cwd, timeoutMs: 120_000 })
}

function counts(output: string): { passed: number; failed: number } {
  const passed = Math.max(0, ...[...output.matchAll(/(\d+) passed/g)].map((match) => Number(match[1])))
  const failed = Math.max(0, ...[...output.matchAll(/(\d+) failed/g)].map((match) => Number(match[1])))
  const errors = Math.max(0, ...[...output.matchAll(/(\d+) error/g)].map((match) => Number(match[1])))
  return { passed, failed: failed + errors }
}

type Candidate = { file: string; find: string; replace: string; note: string }

const TRANSFORMS: Array<{ pattern: RegExp; replacement: string; note: string }> = [
  { pattern: / == /, replacement: " != ", note: "eq->neq" },
  { pattern: / != /, replacement: " == ", note: "neq->eq" },
  { pattern: / is not None/, replacement: " is None", note: "notnone->none" },
  { pattern: / is None/, replacement: " is not None", note: "none->notnone" },
  { pattern: / and /, replacement: " or ", note: "and->or" },
  { pattern: / or /, replacement: " and ", note: "or->and" },
  { pattern: /<=/, replacement: "<", note: "le->lt" },
  { pattern: />=/, replacement: ">", note: "ge->gt" },
  { pattern: /True/, replacement: "False", note: "true->false" },
  { pattern: /False/, replacement: "True", note: "false->true" },
  { pattern: / \+ 1/, replacement: " - 1", note: "plus1->minus1" },
  { pattern: /Valid\(/, replacement: "Invalid(", note: "valid->invalid" },
  { pattern: /Invalid\(/, replacement: "Valid(", note: "invalid->valid" },
  { pattern: /Success\(/, replacement: "Failure(", note: "success->failure" },
  { pattern: /Failure\(/, replacement: "Success(", note: "failure->success" },
  { pattern: /(^\s*)if /, replacement: "$1if not ", note: "if->ifnot" },
]

function candidatesFromPatch(patch: string): Candidate[] {
  const out: Candidate[] = []
  let file = ""
  let inDoc = false
  for (const line of patch.split("\n")) {
    const header = line.match(/^\+\+\+ b\/(.+)$/)
    if (header) {
      file = header[1]!
      inDoc = false
      continue
    }
    if (!line.startsWith("+") || line.startsWith("+++")) continue
    if (/test/i.test(file)) continue
    const text = line.slice(1)
    const trimmed = text.trim()
    const quotes = (trimmed.match(/"""/g) ?? []).length
    if (inDoc) {
      if (quotes % 2 === 1) inDoc = false
      continue
    }
    if (quotes % 2 === 1) {
      inDoc = true
      continue
    }
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(">>>") || trimmed.startsWith("...")) continue
    if (!/[()\[\]=:.]/.test(trimmed)) continue
    if (/^[A-Za-z][A-Za-z ,'`-]*$/.test(trimmed)) continue
    for (const transform of TRANSFORMS) {
      if (transform.pattern.test(text)) {
        out.push({ file, find: text, replace: text.replace(transform.pattern, transform.replacement), note: transform.note })
        break
      }
    }
  }
  return out
}

async function prepareRepo(task: BaseTask, perRepo: number, force: boolean): Promise<Array<Record<string, unknown>>> {
  const taskDir = join(WORK, task.id)
  const baseWs = join(taskDir, "ws")
  const envDir = join(taskDir, "env")
  if (!existsSync(baseWs) || !existsSync(envDir)) throw new Error(`${task.id}: base workspace/env missing; run prepare first`)
  const patchDir = join(DEEPSWE, "tasks", task.id)
  const solution = readFileSync(join(patchDir, "solution", "solution.patch"), "utf8")
  const testPatch = readFileSync(join(patchDir, "tests", "test.patch"), "utf8")
  const candidates = candidatesFromPatch(solution)
  log(`${task.id}: ${candidates.length} mutation candidates`)

  const scratch = join(taskDir, "mutant-scratch")
  rmSync(scratch, { recursive: true, force: true })
  cpSync(baseWs, scratch, { recursive: true, filter: (source) => !/(^|\/)(__pycache__|\.pytest_cache)(\/|$)/.test(source) })
  for (const [name, patch] of [["solution", solution], ["tests", testPatch]] as const) {
    const patchFile = join(scratch, `${name}.patch`)
    writeFileSync(patchFile, patch)
    const applied = await git(["apply", "--whitespace=nowarn", patchFile], scratch)
    if (applied.code !== 0) throw new Error(`${task.id}: ${name} patch failed: ${applied.stderr}`)
    rmSync(patchFile, { force: true })
  }

  const targetCmd = task.newCmd.filter((arg) => arg !== "--junitxml={junit}")
  const env = {
    PATH: `${join(envDir, "bin")}:${process.env.PATH ?? ""}`,
    VIRTUAL_ENV: envDir,
    PYTHONPATH: task.pythonPath.map((entry) => resolve(scratch, entry)).join(":"),
  }
  const baseline = await run(targetCmd[0]!, targetCmd.slice(1), { cwd: scratch, env, timeoutMs: 300_000 })
  const baselineCounts = counts(`${baseline.stdout}\n${baseline.stderr}`)
  log(`${task.id}: solved state ${baselineCounts.passed} passed / ${baselineCounts.failed} failed (exit ${baseline.code})`)
  if (baseline.code !== 0 || baselineCounts.failed > 0) throw new Error(`${task.id}: solved state does not pass its tests`)

  const picked: Candidate[] = []
  for (const candidate of candidates) {
    if (picked.length >= perRepo) break
    const path = join(scratch, candidate.file)
    if (!existsSync(path)) continue
    const original = readFileSync(path, "utf8")
    if (!original.includes(candidate.find)) continue
    writeFileSync(path, original.replace(candidate.find, candidate.replace))
    const result = await run(targetCmd[0]!, targetCmd.slice(1), { cwd: scratch, env, timeoutMs: 300_000 })
    const resultCounts = counts(`${result.stdout}\n${result.stderr}`)
    writeFileSync(path, original)
    const interesting = resultCounts.passed > 0 && resultCounts.failed > 0
    log(`${task.id}: candidate ${candidate.file} ${candidate.note} → ${resultCounts.passed} passed / ${resultCounts.failed} failed ${interesting ? "KEEP" : "skip"}`)
    if (interesting) picked.push(candidate)
  }

  const entries: Array<Record<string, unknown>> = []
  for (const [index, mutation] of picked.entries()) {
    const id = `mutant-${task.id.split("-")[0]}-${index + 1}`
    const ws = join(WORK, id, "ws")
    if (existsSync(ws) && !force) {
      log(`${id}: workspace exists`)
    } else {
      rmSync(ws, { recursive: true, force: true })
      mkdirSync(join(WORK, id), { recursive: true })
      cpSync(baseWs, ws, { recursive: true, filter: (source) => !/(^|\/)(__pycache__|\.pytest_cache)(\/|$)/.test(source) })
      for (const [name, patch] of [["solution", solution], ["tests", testPatch]] as const) {
        const patchFile = join(WORK, id, `${name}.patch`)
        writeFileSync(patchFile, patch)
        const applied = await git(["apply", "--whitespace=nowarn", patchFile], ws)
        if (applied.code !== 0) throw new Error(`${id}: ${name} patch failed: ${applied.stderr}`)
        rmSync(patchFile, { force: true })
      }
      const path = join(ws, mutation.file)
      writeFileSync(path, readFileSync(path, "utf8").replace(mutation.find, mutation.replace))
    }
    const check = await run(targetCmd[0]!, targetCmd.slice(1), {
      cwd: ws,
      env: { ...env, PYTHONPATH: task.pythonPath.map((entry) => resolve(ws, entry)).join(":") },
      timeoutMs: 300_000,
    })
    const checkCounts = counts(`${check.stdout}\n${check.stderr}`)
    log(`${id}: workspace check ${checkCounts.passed} passed / ${checkCounts.failed} failed`)
    if (!(checkCounts.passed > 0 && checkCounts.failed > 0)) throw new Error(`${id}: mutation did not produce a partial failure`)
    entries.push({
      id,
      baseTask: task.id,
      repo: task.repo,
      baseCommit: task.baseCommit,
      pythonPath: task.pythonPath,
      envFrom: task.id,
      simpleGrade: true,
      verifyCmd: targetCmd,
      instruction:
        `The test suite \`${targetCmd.join(" ")}\` is failing after a recent change. ` +
        `Find the regression in the source code and fix it so all of these tests pass. ` +
        `Do not modify the tests. Run the tests to confirm your fix.`,
      mutation,
    })
  }
  return entries
}

const flags = parseFlags(process.argv.slice(2))
const perRepo = typeof flags["per-repo"] === "string" ? Number(flags["per-repo"]) : 2
const force = flags.force === true
const all: Array<Record<string, unknown>> = []
for (const id of REPOS) {
  const task = baseManifest.tasks.find((candidate) => candidate.id === id)
  if (!task) throw new Error(`unknown base task ${id}`)
  all.push(...(await prepareRepo(task, perRepo, force)))
}
const manifest = {
  model: "deepseek-v4.1-flash",
  baseUrl: "https://opencode.ai/inference/openai/v1",
  benchmark: "local mutants of datacurve/deep-swe tasks (reference solution + tests + injected regression)",
  tasks: all,
}
writeFileSync(MUTANTS_FILE, `${JSON.stringify(manifest, null, 2)}\n`)
log(`wrote ${all.length} mutants → ${MUTANTS_FILE}`)
