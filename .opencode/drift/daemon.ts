import { spawn } from "node:child_process"
import { existsSync, mkdirSync, openSync } from "node:fs"
import { join } from "node:path"
import { daemonUrl } from "./config"
import type { DriftConfig } from "./config"
import type { LayaResponse, QuestionDef } from "./types"

export type Health = {
  ok: boolean
  ready: boolean
  loading: boolean
  error: string | null
  checkpoint: string
  device: string
  pid: number
}

export type Logger = (level: "debug" | "info" | "warn" | "error", message: string, extra?: unknown) => void

let ensuring: Promise<Health | null> | null = null

export async function checkHealth(config: DriftConfig, timeoutMs = 3000): Promise<Health | null> {
  try {
    const response = await fetch(`${daemonUrl(config)}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    return (await response.json()) as Health
  } catch {
    return null
  }
}

export function daemonScript(directory: string, config: DriftConfig): string {
  if (config.daemon.script) {
    return config.daemon.script.startsWith("/") ? config.daemon.script : join(directory, config.daemon.script)
  }
  return join(directory, "src", "driftd.py")
}

function startDaemon(directory: string, config: DriftConfig, log: Logger): boolean {
  const script = daemonScript(directory, config)
  if (!existsSync(script)) {
    log("warn", `drift daemon script not found at ${script}; start it manually or run scripts/setup.sh`)
    return false
  }
  if (!existsSync(config.daemon.python)) {
    log("warn", `python interpreter not found at ${config.daemon.python}; run scripts/setup.sh`)
    return false
  }
  mkdirSync(config.stateDir, { recursive: true })
  const logFd = openSync(join(config.stateDir, "driftd.log"), "a")
  const args = [
    script,
    "--port",
    String(config.daemon.port),
    "--host",
    config.daemon.host,
    "--checkpoint",
    config.daemon.checkpoint,
  ]
  if (config.daemon.device) args.push("--device", config.daemon.device)
  const child = spawn(config.daemon.python, args, {
    cwd: directory,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, USE_TF: "0", TOKENIZERS_PARALLELISM: "false" },
  })
  child.unref()
  log("info", `started drift daemon pid=${child.pid} checkpoint=${config.daemon.checkpoint}`)
  return true
}

export function ensureDaemon(
  directory: string,
  config: DriftConfig,
  log: Logger,
): Promise<Health | null> {
  if (ensuring) return ensuring
  ensuring = (async () => {
    const first = await checkHealth(config)
    if (first?.ready) return first
    if (first && !first.ready) {
      log("info", "drift daemon is already loading its checkpoint")
    } else if (config.daemon.autostart) {
      startDaemon(directory, config, log)
    } else {
      log("warn", "drift daemon is not reachable and autostart is disabled")
      return null
    }
    const deadline = Date.now() + config.daemon.startTimeoutMs
    let lastNotice = 0
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2500))
      const health = await checkHealth(config)
      if (health?.ready) {
        log("info", `drift daemon ready on ${config.daemon.device} (${config.daemon.checkpoint})`)
        return health
      }
      if (health?.error) {
        log("error", `drift daemon failed to load checkpoint: ${health.error}`)
        return health
      }
      if (Date.now() - lastNotice > 30000) {
        lastNotice = Date.now()
        log("info", "still loading the Laya checkpoint…")
      }
    }
    log("error", "timed out waiting for the drift daemon")
    return null
  })()
  try {
    return ensuring.finally(() => {
      ensuring = null
    })
  } catch {
    ensuring = null
    return Promise.resolve(null)
  }
}

export async function scoreWithLaya(
  config: DriftConfig,
  state: string,
  questions: Record<string, QuestionDef>,
): Promise<LayaResponse> {
  try {
    const response = await fetch(`${daemonUrl(config)}/score`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state, questions }),
      signal: AbortSignal.timeout(120000),
    })
    return (await response.json()) as LayaResponse
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
