/**
 * Tunes probe weights and the saturation constant against the session-test
 * fixtures: on-plan (0 by construction), partial drift (auth rewrite) and a
 * full task switch (marketing). Prints candidate scores so you can pick a
 * config that is strict without being hair-trigger.
 *
 *   bun scripts/tune-weights.ts
 */
import { loadConfig } from "../.opencode/drift/config"
import { buildDigest } from "../.opencode/drift/digest"
import { questionDivergence, vectorize } from "../.opencode/drift/embed"
import { DRIFT_QUESTIONS } from "../.opencode/drift/questions"
import { scoreWithLaya } from "../.opencode/drift/daemon"

const directory = new URL("..", import.meta.url).pathname.replace(/\/$/, "")
const config = loadConfig(directory)
const PLAN = "Add a /health endpoint to the FastAPI service and cover it with a pytest test that asserts 200."

const ON_PLAN = [
  { info: { role: "user" }, parts: [{ type: "text", text: PLAN }] },
  { info: { role: "assistant" }, parts: [{ type: "text", text: "Starting the health route now." }, { type: "tool", tool: "edit", state: { status: "completed", input: { filePath: "app/routes/health.py" } } }] },
]
const PARTIAL = [
  ...ON_PLAN,
  { info: { role: "user" }, parts: [{ type: "text", text: "While you are in there, rewrite the whole auth layer with Redis." }] },
  { info: { role: "assistant" }, parts: [{ type: "tool", tool: "edit", state: { status: "completed", input: { filePath: "auth/session.py" } } }, { type: "text", text: "Replaced the session store with Redis and migrated OAuth." }] },
]
const SWITCH = [
  ...ON_PLAN,
  { info: { role: "user" }, parts: [{ type: "text", text: "Drop the health work entirely and rebuild the marketing homepage design." }] },
  { info: { role: "assistant" }, parts: [{ type: "tool", tool: "edit", state: { status: "completed", input: { filePath: "web/home.css" } } }, { type: "text", text: "Rewrote the homepage layout and CSS from scratch." }] },
]

async function embed(messages: unknown[]) {
  const digest = buildDigest({ anchor: PLAN, messages: messages as never, budgetChars: config.scoring.digestChars })
  const response = await scoreWithLaya(config, digest, DRIFT_QUESTIONS)
  return { digest, vector: vectorize(response.answers!) }
}

const baseline = await embed(ON_PLAN)

const rows: Array<{ name: string; divergences: Record<string, number> }> = []
for (const [name, messages] of [["PARTIAL", PARTIAL], ["SWITCH", SWITCH]] as const) {
  const { vector } = await embed(messages)
  const divergences: Record<string, number> = {}
  for (const id of Object.keys(DRIFT_QUESTIONS)) {
    divergences[id] = questionDivergence(id, baseline.vector[id]!, vector[id]!)
  }
  rows.push({ name, divergences })
}

console.log("baseline digest:\n" + baseline.digest + "\n")
console.log("per-question divergence:")
for (const row of rows) console.log(" ", row.name.padEnd(8), JSON.stringify(row.divergences))

const candidates: Array<{ w: Record<string, number>; k: number }> = []
for (const alignment of [0.8, 0.75, 0.7]) {
  for (const k of [6, 6.5, 7, 7.5, 8]) {
    candidates.push({ w: { alignment, plan_ref: 1 - alignment }, k })
  }
}

console.log("\ncandidates (score = 100·(1-e^(-k·weighted_mean))):")
for (const { w, k } of candidates) {
  const cells = rows.map((row) => {
    const ids = Object.keys(w)
    const mean = ids.reduce((sum, id) => sum + w[id]! * row.divergences[id]!, 0)
    const score = 100 * (1 - Math.exp(-k * mean))
    return `${row.name}=${score.toFixed(0)}`
  })
  console.log(`  align=${w.alignment} plan_ref=${w.plan_ref} k=${k}  ${cells.join("  ")}`)
}
