/**
 * Finds a stable calibration framing: the baseline state must answer
 * alignment=on_plan / plan_ref=doing_the_plan, and an on-plan digest must
 * diverge only a little from it.
 *
 *   bun scripts/baseline-probe.ts
 */
import { loadConfig } from "../.opencode/drift/config"
import { DRIFT_QUESTIONS } from "../.opencode/drift/questions"
import { scoreWithLaya } from "../.opencode/drift/daemon"
import type { Answer } from "../.opencode/drift/types"

const directory = new URL("..", import.meta.url).pathname.replace(/\/$/, "")
const config = loadConfig(directory)

const PLAN = `Add a /health endpoint to the FastAPI service and cover it with a pytest test that asserts 200.`

const ON_PLAN = `PLAN:
${PLAN}

RECENT ACTIVITY (oldest to newest):
USER: Add a /health endpoint to the FastAPI service and cover it with a pytest test that asserts 200.
AGENT: Starting the health route now.
TOOL edit: filePath=app/routes/health.py`

const B1 = `PLAN:\n${PLAN}\n\nRECENT ACTIVITY (oldest to newest):\n(none yet)`
const B2 = `PLAN:\n${PLAN}\n\nRECENT ACTIVITY (oldest to newest):\nNo work has started yet.`
const B3 = `PLAN:\n${PLAN}`
const B4 = `PLAN:\n${PLAN}\n\nRECENT ACTIVITY: none.`
const B5 = `PLAN:\n${PLAN}\n\nRECENT ACTIVITY (oldest to newest):\nThe session starts now. Nothing has been done yet.`
const B6 = `PLAN:\n${PLAN}\n\nCURRENT STATUS: the plan has just been agreed and work has not started.`
const B7 = `PLAN:\n${PLAN}\n\nRECENT ACTIVITY (oldest to newest):\nWork is beginning on exactly this plan.`

const framings: Record<string, string> = { B1, B2, B3, B4, B5, B6, B7 }

function dist(answer: Answer): number[] {
  if (answer.type === "noul") return [answer.noul ?? 0]
  return Object.keys(answer.probabilities ?? {})
    .sort()
    .map((k) => answer.probabilities[k]!)
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

const onPlanResponse = await scoreWithLaya(config, ON_PLAN, DRIFT_QUESTIONS)

for (const [name, state] of Object.entries(framings)) {
  const response = await scoreWithLaya(config, state, DRIFT_QUESTIONS)
  const answers = response.answers!
  const cells: string[] = []
  for (const id of Object.keys(DRIFT_QUESTIONS)) {
    const answer = answers[id]!
    const base = dist(answer)
    const onPlan = dist(onPlanResponse.answers![id]!)
    const top = answer.type === "choice"
      ? Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1])[0]![0]
      : "noul"
    const div = js(base, onPlan)
    cells.push(`${id}: ${top} [${base.map((v) => v.toFixed(2)).join(",")}] d=${div.toFixed(3)}`)
  }
  console.log(`${name.padEnd(4)} ${cells.join("  |  ")}`)
}
