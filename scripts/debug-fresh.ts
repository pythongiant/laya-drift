import { loadConfig } from "../.opencode/drift/config"
import { stateFor } from "../.opencode/drift/digest"
import { computeDrift, vectorize } from "../.opencode/drift/embed"
import { DRIFT_QUESTIONS } from "../.opencode/drift/questions"
import { scoreWithLaya } from "../.opencode/drift/daemon"

const directory = new URL("..", import.meta.url).pathname.replace(/\/$/, "")
const config = loadConfig(directory)
const PLAN = "Add a /health endpoint to the FastAPI service and cover it with a pytest test that asserts 200."

const chatter = [
  { info: { role: "user" }, parts: [{ type: "text", text: "The user invoked /calibrate. Call the `drift_calibrate` tool exactly once." }] },
  { info: { role: "assistant" }, parts: [{ type: "tool", tool: "drift_calibrate", state: { status: "completed", input: {} } }, { type: "text", text: "Drift baseline calibrated.\nDRIFT 0.0/100 ▁ on-plan · top: baseline · calibrated 0m ago" }] },
]
const work = [
  ...chatter,
  { info: { role: "user" }, parts: [{ type: "text", text: "Implement the health route per the plan." }] },
  { info: { role: "assistant" }, parts: [{ type: "tool", tool: "edit", state: { status: "completed", input: { filePath: "app/routes/health.py" } } }, { type: "text", text: "Added the route and the pytest test." }] },
]

const baselineState = stateFor({ anchor: PLAN, messages: chatter as never, budgetChars: config.scoring.digestChars })
const currentState = stateFor({ anchor: PLAN, messages: work as never, budgetChars: config.scoring.digestChars })
console.log("=== baseline ===\n" + baselineState)
console.log("\n=== current ===\n" + currentState)

const base = await scoreWithLaya(config, baselineState, DRIFT_QUESTIONS)
const cur = await scoreWithLaya(config, currentState, DRIFT_QUESTIONS)
const bv = vectorize(base.answers!)
const cv = vectorize(cur.answers!)
console.log("\nbaseline vectors", JSON.stringify(bv))
console.log("current vectors ", JSON.stringify(cv))
const drift = computeDrift(bv, cv, config.scoring.weights, config.scoring.sensitivity)
console.log("score", drift.score, drift.band, drift.perQuestion)
