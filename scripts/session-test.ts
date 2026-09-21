/**
 * Exercises the controller end to end without opencode: mock client messages,
 * calibrate, score, recalibrate, score again. Verifies the state file, the
 * digest path and the reset behaviour.
 *
 *   bun scripts/session-test.ts
 */
import { loadConfig } from "../.opencode/drift/config"
import { calibrate, recalibrate, scoreSession, statusText } from "../.opencode/drift/controller"
import { readState } from "../.opencode/drift/store"
import type { ClientLike } from "../.opencode/drift/controller"

const directory = new URL("..", import.meta.url).pathname.replace(/\/$/, "")
const config = loadConfig(directory)
const sessionID = `test_${Date.now()}`
const log = (level: string, message: string) => console.log(`[${level}] ${message}`)

type MockMessage = { info: { role: string }; parts: Array<Record<string, unknown>> }

const PLAN_TEXT = "Add a /health endpoint to the FastAPI service and cover it with a pytest test that asserts 200."
const ON_PLAN: MockMessage[] = [
  { info: { role: "user" }, parts: [{ type: "text", text: PLAN_TEXT }] },
  { info: { role: "assistant" }, parts: [{ type: "text", text: "Starting the health route now." }, { type: "tool", tool: "edit", state: { status: "completed", input: { filePath: "app/routes/health.py" } } }] },
]
const DRIFTED: MockMessage[] = [
  ...ON_PLAN,
  { info: { role: "user" }, parts: [{ type: "text", text: "While you are in there, rewrite the whole auth layer with Redis." }] },
  { info: { role: "assistant" }, parts: [{ type: "tool", tool: "edit", state: { status: "completed", input: { filePath: "auth/session.py" } } }, { type: "text", text: "Replaced the session store with Redis and migrated OAuth." }] },
]

let messages: MockMessage[] = []
const client = {
  session: {
    messages: async () => ({ data: messages }),
    todo: async () => ({ data: [] }),
  },
} as unknown as ClientLike

function assert(condition: boolean, label: string): void {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}`)
  if (!condition) process.exitCode = 1
}

messages = ON_PLAN
const baseline = await calibrate({ client, directory, config, log, sessionID, plan: PLAN_TEXT })
assert(baseline.score === 0, "calibration sets score 0")
assert(readState(config.stateDir, sessionID) !== null, "state file written")

const onPlan = await scoreSession({ client, directory, config, log, sessionID, trigger: "test", force: true })
assert(onPlan !== null && onPlan.score < 10, `on-plan stays low (${onPlan?.score})`)

messages = DRIFTED
const drifted = await scoreSession({ client, directory, config, log, sessionID, trigger: "test", force: true })
assert(drifted !== null && drifted.score > onPlan!.score + 10, `drifted rises (${drifted?.score} vs ${onPlan?.score})`)

const beforeRecal = readState(config.stateDir, sessionID)!
assert(beforeRecal.history.length >= 2, "history records both scores")
console.log(`      ${statusText(beforeRecal)}`)

const recal = await recalibrate({ client, directory, config, log, sessionID, plan: "New focus: rewrite auth on Redis; the health endpoint is done." })
assert(recal.anchor.includes(beforeRecal.anchor), "recalibrated anchor keeps the previous baseline")
assert(recal.score === 0, "recalibration resets drift to 0")

const settled = await scoreSession({ client, directory, config, log, sessionID, trigger: "test", force: true })
assert(settled !== null && settled.score < 10, `reset holds on the next score (${settled?.score})`)

const NEW_DRIFT = [
  ...DRIFTED,
  { info: { role: "user" }, parts: [{ type: "text", text: "Drop the auth work entirely and rebuild the marketing homepage design." }] },
  { info: { role: "assistant" }, parts: [{ type: "tool", tool: "edit", state: { status: "completed", input: { filePath: "web/home.css" } } }, { type: "text", text: "Rewrote the homepage layout and CSS from scratch." }] },
]
messages = NEW_DRIFT
const newDrift = await scoreSession({ client, directory, config, log, sessionID, trigger: "test", force: true })
assert(newDrift !== null && newDrift.score > settled!.score + 8, `new drift after recalibration rises (${newDrift?.score} vs ${settled?.score})`)

// Fresh session: the only messages are the calibration command and its reply.
// They must be treated as chatter, not as off-plan work.
const freshID = `test_fresh_${Date.now()}`
const freshMessages: MockMessage[] = [
  { info: { role: "user" }, parts: [{ type: "text", text: "The user invoked /calibrate. Call the `drift_calibrate` tool exactly once." }] },
  { info: { role: "assistant" }, parts: [{ type: "tool", tool: "drift_calibrate", state: { status: "completed", input: {} } }, { type: "text", text: "Drift baseline calibrated.\nDRIFT 0.0/100 ▁ on-plan · top: baseline · calibrated 0m ago" }] },
]
messages = freshMessages
const freshCal = await calibrate({ client, directory, config, log, sessionID: freshID, plan: PLAN_TEXT })
assert(freshCal.score === 0, "fresh session calibration sets score 0")
const freshIdle = await scoreSession({ client, directory, config, log, sessionID: freshID, trigger: "turn", force: true })
assert(freshIdle !== null && freshIdle.score < 5, `calibration chatter does not score as drift (${freshIdle?.score})`)

const freshWork: MockMessage[] = [
  ...freshMessages,
  { info: { role: "user" }, parts: [{ type: "text", text: "Implement the health route per the plan." }] },
  { info: { role: "assistant" }, parts: [{ type: "tool", tool: "edit", state: { status: "completed", input: { filePath: "app/routes/health.py" } } }, { type: "text", text: "Added the route and the pytest test." }] },
]
messages = freshWork
const freshOnPlan = await scoreSession({ client, directory, config, log, sessionID: freshID, trigger: "turn", force: true })
assert(freshOnPlan !== null && freshOnPlan.score < 5, `first activity becomes the anchor (${freshOnPlan?.score})`)

const freshDrift: MockMessage[] = [
  ...freshWork,
  { info: { role: "user" }, parts: [{ type: "text", text: "Forget the endpoint; rebuild the marketing homepage instead." }] },
  { info: { role: "assistant" }, parts: [{ type: "tool", tool: "edit", state: { status: "completed", input: { filePath: "web/home.css" } } }, { type: "text", text: "Rewrote the homepage layout and CSS." }] },
]
messages = freshDrift
const freshDriftScore = await scoreSession({ client, directory, config, log, sessionID: freshID, trigger: "turn", force: true })
assert(freshDriftScore !== null && freshDriftScore.score > freshOnPlan!.score + 8, `drift after the anchor rises (${freshDriftScore?.score})`)

console.log("\nstate file:", `${config.stateDir}/sessions/${sessionID}.json`)
