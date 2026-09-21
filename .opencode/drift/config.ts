import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { existsSync, readFileSync } from "node:fs"

export type DriftConfig = {
  daemon: {
    host: string
    port: number
    checkpoint: "english" | "multilingual" | "typed-decisions"
    device?: string
    python: string
    script?: string
    autostart: boolean
    startTimeoutMs: number
  }
  scoring: {
    sensitivity: number
    minIntervalMs: number
    historyLimit: number
    digestChars: number
    weights: Record<string, number>
  }
  display: {
    slot: boolean
    toastMode: "changes" | "always" | "off"
    warnThreshold: number
    alertThreshold: number
    injectSystemAbove: number | null
  }
  stateDir: string
}

export const DEFAULT_CONFIG: DriftConfig = {
  daemon: {
    host: "127.0.0.1",
    port: 8765,
    checkpoint: "multilingual",
    python: "",
    autostart: true,
    startTimeoutMs: 15 * 60 * 1000,
  },
  scoring: {
    sensitivity: 4.5,
    minIntervalMs: 3000,
    historyLimit: 60,
    digestChars: 2800,
    weights: {
      alignment: 0.6,
      plan_ref: 0.4,
    },
  },
  display: {
    slot: true,
    toastMode: "changes",
    warnThreshold: 35,
    alertThreshold: 65,
    injectSystemAbove: 30,
  },
  stateDir: "~/.local/share/laya-drift",
}

function expandHome(path: string): string {
  if (path === "~") return homedir()
  if (path.startsWith("~/")) return join(homedir(), path.slice(2))
  return path
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (Array.isArray(base) || Array.isArray(override)) return override ?? base
  if (typeof base === "object" && base !== null && typeof override === "object" && override !== null) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
    for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
      out[key] = deepMerge((base as Record<string, unknown>)[key], value)
    }
    return out
  }
  return override === undefined ? base : override
}

export function configFile(directory: string): string {
  return join(directory, ".opencode", "drift.json")
}

export function loadConfig(directory: string): DriftConfig {
  let merged: DriftConfig = DEFAULT_CONFIG
  const file = configFile(directory)
  try {
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<DriftConfig>
      merged = deepMerge(DEFAULT_CONFIG, raw) as DriftConfig
    }
  } catch {
    merged = DEFAULT_CONFIG
  }
  merged.stateDir = expandHome(merged.stateDir)
  if (!merged.daemon.python) {
    const venv = join(directory, ".venv", "bin", "python")
    merged.daemon.python = existsSync(venv) ? venv : "python3"
  } else if (!isAbsolute(merged.daemon.python)) {
    merged.daemon.python = resolve(directory, merged.daemon.python)
  }
  return merged
}

export function daemonUrl(config: DriftConfig): string {
  return `http://${config.daemon.host}:${config.daemon.port}`
}

export function stateDir(config: DriftConfig): string {
  return config.stateDir
}
