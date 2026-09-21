/**
 * Tests "positive exemplar" baselines: the baseline state uses the same
 * PLAN + RECENT ACTIVITY structure as scoring states, with the activity
 * describing canonical on-plan work. Then measures on-plan / drifted /
 * off-plan divergences to pick the framing with the cleanest ordering.
 *
 *   bun scripts/baseline-probe2.ts
 */
import { loadConfig } from "../.opencode/drift/config"
import { DRIFT_QUESTIONS } from "../.opencode/drift/questions"
import { scoreWithLaya } from "../.opencode/drift/daemon"
import type { Answer } from "../.opencode/drift/types"

const directory = new URL("..", import.meta.url).pathname.replace(/\/$/, "")
const config = loadConfig(directory)

const PLAN = `Add a /health endpoint to the FastAPI service and cover it with a pytest test that asserts 200.`

const wrap = (anchor: string, activity: string) =>
  `PLAN:\n${anchor}\n\nRECENT ACTIVITY (oldest to newest):\n${activity}`

const baselines: Record<string, string> = {
  C1: wrap(PLAN, `The work follows the plan exactly as written: ${PLAN}`),
  C2: wrap(PLAN, PLAN),
  C3: wrap(PLAN, `USER: Execute the plan exactly as written.\nAGENT: Working through the plan step by step.`),
  C4: wrap(PLAN, `Work so far matches the plan point by point.`),
  C5: wrap(PLAN, `USER: Implement the plan.\nTOOL edit: filePath=the files named in the plan\nAGENT: The work is exactly what the plan describes.`),
}

const states: Record<string, string> = {
  ON_PLAN: wrap(
    PLAN,
    `USER: Add a /health endpoint to the FastAPI service and cover it with a pytest test that asserts 200.\nAGENT: Starting the health route now.\nTOOL edit: filePath=app/routes/health.py`,
  ),
  DRIFTED: wrap(
    PLAN,
    `USER: Add a /health endpoint to the FastAPI service and cover it with a pytest test that asserts 200.\nTOOL edit: filePath=app/routes/health.py\nUSER: While you are in there, rewrite the whole auth layer with Redis.\nAGENT: Replaced the session store with Redis and migrated OAuth.\nTOOL edit: filePath=auth/session.py`,
  ),
  OFF_PLAN: wrap(
    PLAN,
    `USER: Forget that, the marketing site needs a redesign.\nTOOL edit: filePath=web/home.css\nAGENT: Renamed all CSS classes and rewrote the homepage copy.`,
  ),
}

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

const k = 6
const weights: Record<string, number> = { alignment: 0.6, plan_ref: 0.4 }

for (const [name, baselineState] of Object.entries(baselines)) {
  const base = await scoreWithLaya(config, baselineState, DRIFT_QUESTIONS)
  const baseVec = Object.fromEntries(Object.entries(base.answers!).map(([id, a]) => [id, dist(a)]))
  const parts: string[] = [`${name}:`]
  for (const [sname, state] of Object.entries(states)) {
    const current = await scoreWithLaya(config, state, DRIFT_QUESTIONS)
    let weighted = 0
    let sum = 0
    for (const id of Object.keys(DRIFT_QUESTIONS)) {
      const div = js(baseVec[id]!, dist(current.answers![id]!))
      weighted += (weights[id] ?? 0) * div
      sum += weights[id] ?? 0
    }
    const mean = weighted / sum
    const score = 100 * (1 - Math.exp(-k * mean))
    parts.push(`${sname}=${score.toFixed(0)}`)
  }
  const alignAnswer = base.answers!.alignment!
  const refAnswer = base.answers!.plan_ref!
  const alignTop = alignAnswer.type !== "noul"
    ? Object.entries(alignAnswer.probabilities).sort((a, b) => b[1] - a[1])[0]!
    : ["noul", alignAnswer.noul]
  const refTop = refAnswer.type !== "noul"
    ? Object.entries(refAnswer.probabilities).sort((a, b) => b[1] - a[1])[0]!
    : ["noul", refAnswer.noul]
  console.log(parts.join(" "), `| base alignment=${alignTop[0]}(${Number(alignTop[1]).toFixed(2)}) plan_ref=${refTop[0]}(${Number(refTop[1]).toFixed(2)})`)
}
