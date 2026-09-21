/**
 * Diagnoses a project's laya-drift setup: resolves the config paths that the
 * daemon autostart uses, then checks (and starts, if needed) the daemon.
 *
 *   bun scripts/doctor.ts /path/to/project
 */
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { loadConfig } from "../.opencode/drift/config"
import { checkHealth, daemonScript, ensureDaemon } from "../.opencode/drift/daemon"

const target = resolve(process.argv[2] ?? new URL("..", import.meta.url).pathname)
const config = loadConfig(target)
const script = daemonScript(target, config)

console.log("project       ", target)
console.log("drift config  ", existsSync(resolve(target, ".opencode", "drift.json")) ? "found" : "missing (defaults apply)")
console.log("python        ", config.daemon.python, existsSync(config.daemon.python) ? "ok" : "MISSING")
console.log("daemon script ", script, existsSync(script) ? "ok" : "MISSING")
console.log("checkpoint    ", config.daemon.checkpoint, "· port", config.daemon.port)
console.log("stateDir      ", config.stateDir)

const health = await checkHealth(config)
if (health?.ready) {
  console.log("daemon        ", `ready on ${health.device} (pid ${health.pid})`)
} else {
  console.log("daemon        ", "not reachable, starting…")
  const started = await ensureDaemon(target, config, (level, message) => console.log(`[${level}]`, message))
  console.log("daemon        ", started?.ready ? `ready on ${started.device}` : "FAILED")
  if (!started?.ready) process.exitCode = 1
}
