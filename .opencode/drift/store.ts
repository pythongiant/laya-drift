import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type { DriftState } from "./types"

function safeID(sessionID: string): string {
  return sessionID.replace(/[^a-zA-Z0-9_-]/g, "_")
}

export function sessionsDir(stateDir: string): string {
  const dir = join(stateDir, "sessions")
  mkdirSync(dir, { recursive: true })
  return dir
}

export function sessionFile(stateDir: string, sessionID: string): string {
  return join(sessionsDir(stateDir), `${safeID(sessionID)}.json`)
}

export function readState(stateDir: string, sessionID: string): DriftState | null {
  try {
    const raw = readFileSync(sessionFile(stateDir, sessionID), "utf8")
    const parsed = JSON.parse(raw) as DriftState
    if (!parsed || parsed.sessionID !== sessionID) return null
    return parsed
  } catch {
    return null
  }
}

export function writeState(stateDir: string, state: DriftState): void {
  const file = sessionFile(stateDir, state.sessionID)
  const tmp = `${file}.tmp`
  const payload = { ...state, updatedAt: Date.now() }
  writeFileSync(tmp, JSON.stringify(payload, null, 2))
  renameSync(tmp, file)
}

export function removeState(stateDir: string, sessionID: string): void {
  try {
    rmSync(sessionFile(stateDir, sessionID), { force: true })
  } catch {
    // best effort
  }
}

export function listSessions(stateDir: string): string[] {
  try {
    return readdirSync(sessionsDir(stateDir))
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.replace(/\.json$/, ""))
  } catch {
    return []
  }
}
