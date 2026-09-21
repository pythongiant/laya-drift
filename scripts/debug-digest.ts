/**
 * Debug: prints the exact digest the controller builds and the raw Laya
 * answers + per-question divergence against the baseline.
 *
 *   bun scripts/debug-digest.ts
 */
import { loadConfig } from "../.opencode/drift/config"
import { buildDigest } from "../.opencode/drift/digest"
import { computeDrift, vectorize } from "../.opencode/drift/embed"
import { DRIFT_QUESTIONS } from "../.opencode/drift/questions"
import { scoreWithLaya } from "../.opencode/drift/daemon"
import type { QuestionDef } from "../.opencode/drift/types"

const directory = new URL("..", import.meta.url).pathname.replace(/\/$/, "")
const config = loadConfig(directory)

const PLAN_TEXT = "Add a /health endpoint to the FastAPI service and cover it with a pytest test that asserts 200."
const ON_PLAN = [
  { info: { role: "user" }, parts: [{ type: "text", text: PLAN_TEXT }] },
  { info: { role: "assistant" }, parts: [{ type: "text", text: "Starting the health route now." }, { type: "tool", tool: "edit", state: { status: "completed", input: { filePath: "app/routes/health.py" } } }] },
]
const DRIFTED = [
  ...ON_PLAN,
  { info: { role: "user" }, parts: [{ type: "text", text: "While you are in there, rewrite the whole auth layer with Redis." }] },
  { info: { role: "assistant" }, parts: [{ type: "tool", tool: "edit", state: { status: "completed", input: { filePath: "auth/session.py" } } }, { type: "text", text: "Replaced the session store with Redis and migrated OAuth." }] },
]

async function answersFor(state: string) {
  const response = await scoreWithLaya(config, state, DRIFT_QUESTIONS)
  return response.answers!
}

const baselineState = `PLAN:\n${PLAN_TEXT}`
const baseline = vectorize(await answersFor(baselineState))
console.log("=== BASELINE ===")
console.log(baselineState)
console.log(JSON.stringify(baseline))

for (const [name, messages] of [["ON_PLAN", ON_PLAN], ["DRIFTED", DRIFTED]] as const) {
  const digest = buildDigest({ anchor: PLAN_TEXT, messages: messages as never, budgetChars: config.scoring.digestChars })
  const vector = vectorize(await answersFor(digest))
  const drift = computeDrift(baseline, vector, config.scoring.weights, config.scoring.sensitivity)
  console.log(`\n=== ${name} (score ${drift.score.toFixed(1)}, ${drift.band}) ===`)
  console.log(digest)
  console.log(JSON.stringify(vector))
  console.log("divergences:", JSON.stringify(drift.perQuestion))
}
