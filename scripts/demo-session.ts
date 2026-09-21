/**
 * Demo-session helper: calibrates a real opencode session against a plan and
 * prints the resulting drift graph, without going through the model.
 *
 *   bun scripts/demo-session.ts calibrate <sessionID> "<plan>"
 *   bun scripts/demo-session.ts graph <sessionID>
 */
import { loadConfig } from "../.opencode/drift/config"
import { calibrate, recalibrate, sessionGraph } from "../.opencode/drift/controller"
import { readState } from "../.opencode/drift/store"
import type { ClientLike } from "../.opencode/drift/controller"

const directory = new URL("..", import.meta.url).pathname.replace(/\/$/, "")
const config = loadConfig(directory)
const [command, sessionID, plan] = process.argv.slice(2)

if (!command || !sessionID) {
  console.error("usage: demo-session.ts calibrate|recalibrate <sessionID> \"<plan>\" | graph <sessionID>")
  process.exit(1)
}

const client = {
  session: {
    messages: async () => ({ data: [] }),
    todo: async () => ({ data: [] }),
  },
} as unknown as ClientLike

if (command === "calibrate") {
  const state = await calibrate({
    client,
    directory,
    config,
    log: (level, message) => console.log(`[${level}] ${message}`),
    sessionID,
    plan,
  })
  console.log(`calibrated ${sessionID} (awaiting first activity: ${state.awaitingFirstActivity})`)
} else if (command === "recalibrate") {
  const state = await recalibrate({
    client,
    directory,
    config,
    log: (level, message) => console.log(`[${level}] ${message}`),
    sessionID,
    plan,
  })
  console.log(`recalibrated ${sessionID} (score reset to ${state.score})`)
} else if (command === "graph") {
  const state = readState(config.stateDir, sessionID)
  if (!state) {
    console.error(`no drift state for ${sessionID}`)
    process.exit(1)
  }
  console.log(sessionGraph(state, config))
} else {
  console.error(`unknown command ${command}`)
  process.exit(1)
}
