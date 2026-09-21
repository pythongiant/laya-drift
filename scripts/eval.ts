/**
 * End-to-end drift check without opencode: sends the plugin's question set to
 * the running drift daemon for a plan, an on-plan update and a drifted update,
 * then runs the real divergence math from .opencode/drift.
 *
 *   bun scripts/eval.ts
 */
import { loadConfig } from "../.opencode/drift/config"
import { buildDigest } from "../.opencode/drift/digest"
import { computeDrift, vectorize } from "../.opencode/drift/embed"
import { DRIFT_QUESTIONS } from "../.opencode/drift/questions"
import { scoreWithLaya, checkHealth } from "../.opencode/drift/daemon"
import { existsSync } from "node:fs"

const directory = new URL("..", import.meta.url).pathname.replace(/\/$/, "")
const config = loadConfig(directory)

const PLAN = `Add a /health endpoint to the FastAPI service and cover it with a pytest test that asserts 200.`

const ON_PLAN_MESSAGES = [
  { info: { role: "user" }, parts: [{ type: "text", text: PLAN }] },
  { info: { role: "assistant" }, parts: [{ type: "text", text: "Starting the health route now." }, { type: "tool", tool: "edit", state: { status: "completed", input: { filePath: "app/routes/health.py" } } }] },
]

const DRIFTED_MESSAGES = [
  ...ON_PLAN_MESSAGES,
  { info: { role: "user" }, parts: [{ type: "text", text: "While you are in there, rewrite the whole auth layer with Redis." }] },
  { info: { role: "assistant" }, parts: [{ type: "tool", tool: "edit", state: { status: "completed", input: { filePath: "auth/session.py" } } }, { type: "text", text: "Replaced the session store with Redis and migrated OAuth." }] },
]

if (!existsSync(config.daemon.python)) {
  console.error(`python not found: ${config.daemon.python}`)
  process.exit(1)
}

const health = await checkHealth(config)
if (!health?.ready) {
  console.error(`daemon not ready: ${JSON.stringify(health)}`)
  console.error(`start it with: .venv/bin/python src/driftd.py --port ${config.daemon.port}`)
  process.exit(1)
}
console.log(`daemon: ${health.checkpoint} on ${health.device}`)

async function embed(state: string): Promise<Record<string, number[]>> {
  const response = await scoreWithLaya(config, state, DRIFT_QUESTIONS)
  if (!response.ok || !response.answers) throw new Error(response.error ?? "no answers")
  return vectorize(response.answers)
}

// Calibration anchors on the state at calibration time (see baselineFor in
// controller.ts): here the on-plan fixture is the moment of calibration.
const baselineState = buildDigest({
  anchor: PLAN,
  messages: ON_PLAN_MESSAGES as never,
  budgetChars: config.scoring.digestChars,
})
const baseline = await embed(baselineState)
const onPlan = await embed(baselineState)
const drifted = await embed(
  buildDigest({ anchor: PLAN, messages: DRIFTED_MESSAGES as never, budgetChars: config.scoring.digestChars }),
)

const onPlanDrift = computeDrift(baseline, onPlan, config.scoring.weights, config.scoring.sensitivity)
const driftedDrift = computeDrift(baseline, drifted, config.scoring.weights, config.scoring.sensitivity)

console.log(`\non-plan : ${onPlanDrift.score.toFixed(1)}/100 (${onPlanDrift.band}) top=${onPlanDrift.top}`)
console.log(`drifted : ${driftedDrift.score.toFixed(1)}/100 (${driftedDrift.band}) top=${driftedDrift.top}`)
console.log(`separation: ${(driftedDrift.score - onPlanDrift.score).toFixed(1)} points`)

if (driftedDrift.score <= onPlanDrift.score) {
  console.error("\nWARNING: drifted state did not score higher than on-plan state. Adjust questions/weights.")
  process.exit(2)
}
console.log("\nOK: drift signal separates the two states.")
