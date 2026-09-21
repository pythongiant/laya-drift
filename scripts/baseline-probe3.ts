/**
 * Picks the canonical on-plan exemplar used as the calibration baseline and
 * verifies the ordering with digests in the exact format the controller
 * builds (buildDigest output).
 *
 *   bun scripts/baseline-probe3.ts
 */
import { loadConfig } from "../.opencode/drift/config"
import { BASELINE_ACTIVITY, buildDigest } from "../.opencode/drift/digest"
import { DRIFT_QUESTIONS } from "../.opencode/drift/questions"
import { scoreWithLaya } from "../.opencode/drift/daemon"
import type { Answer } from "../.opencode/drift/types"

const directory = new URL("..", import.meta.url).pathname.replace(/\/$/, "")
const config = loadConfig(directory)

const PLAN = `Add a /health endpoint to the FastAPI service and cover it with a pytest test that asserts 200.`

const exemplars: Record<string, string> = {
  e1: `USER: Implement the plan.\nTOOL edit: filePath=the files named in the plan\nAGENT: The work is exactly what the plan describes.`,
  e2: `USER: Start on the plan.\nAGENT: Working only on what the plan describes.`,
  e3: `USER: Begin the planned work.\nAGENT: Implementing the plan as written.`,
  e4: `USER: Implement the plan exactly as written.\nAGENT: Proceeding through the plan step by step.`,
  current: BASELINE_ACTIVITY,
}

const ON_PLAN = [
  { info: { role: "user" }, parts: [{ type: "text", text: PLAN }] },
  { info: { role: "assistant" }, parts: [{ type: "text", text: "Starting the health route now." }, { type: "tool", tool: "edit", state: { status: "completed", input: { filePath: "app/routes/health.py" } } }] },
]
const DRIFTED = [
  ...ON_PLAN,
  { info: { role: "user" }, parts: [{ type: "text", text: "While you are in there, rewrite the whole auth layer with Redis." }] },
  { info: { role: "assistant" }, parts: [{ type: "tool", tool: "edit", state: { status: "completed", input: { filePath: "auth/session.py" } } }, { type: "text", text: "Replaced the session store with Redis and migrated OAuth." }] },
]
const OFF_PLAN = [
  { info: { role: "user" }, parts: [{ type: "text", text: PLAN }] },
  { info: { role: "user" }, parts: [{ type: "text", text: "Forget that, the marketing site needs a redesign." }] },
  { info: { role: "assistant" }, parts: [{ type: "tool", tool: "edit", state: { status: "completed", input: { filePath: "web/home.css" } } }, { type: "text", text: "Renamed all CSS classes and rewrote the homepage copy." }] },
]

function dist(answer: Answer): number[] {
  if (answer.type === "noul") return [answer.noul ?? 0]
  return Object.values(answer.probabilities ?? {})
}

function js(p: number[], q: number[]): number {
  const n = Math.max(p.length, q.length)
  let d = 0
  for (let i = 0; i < n; i += 1) {
    const pi = p[i] ?? 0
    const qi = q[i] ?? 0
    const m = (pi + qi) / 2
    if (pi > 0) d += 0.5 * pi * Math.log2(pi / m)
    if (qi > 0) d += 0.5 * qi * Math.log2(qi / m)
  }
  return d
}

const weights: Record<string, number> = { alignment: 0.6, plan_ref: 0.4 }

for (const [name, activity] of Object.entries(exemplars)) {
  const withExemplar = `PLAN:\n${PLAN}\n\nRECENT ACTIVITY (oldest to newest):\n${activity}`
  const base = await scoreWithLaya(config, withExemplar, DRIFT_QUESTIONS)
  const baseVec = Object.fromEntries(Object.entries(base.answers!).map(([id, a]) => [id, dist(a)]))

  const scores: string[] = []
  for (const [sname, messages] of [["ON", ON_PLAN], ["DRIFT", DRIFTED], ["OFF", OFF_PLAN]] as const) {
    const digest = buildDigest({ anchor: PLAN, messages: messages as never, budgetChars: 2800 })
    const current = await scoreWithLaya(config, digest, DRIFT_QUESTIONS)
    let weighted = 0
    const per: string[] = []
    for (const id of Object.keys(DRIFT_QUESTIONS)) {
      const div = js(baseVec[id]!, dist(current.answers![id]!))
      weighted += (weights[id] ?? 0) * div
      per.push(`${id}=${div.toFixed(3)}`)
    }
    const score = 100 * (1 - Math.exp(-3 * weighted))
    scores.push(`${sname}=${score.toFixed(0)} [${per.join(" ")}]`)
  }
  const alignAnswer = base.answers!.alignment!
  const alignTop = alignAnswer.type !== "noul"
    ? Object.entries(alignAnswer.probabilities).sort((a, b) => b[1] - a[1])[0]!
    : ["noul", alignAnswer.noul]
  console.log(`${name} base(${alignTop[0]}=${Number(alignTop[1]).toFixed(2)}): ${scores.join("  ")}`)
}


