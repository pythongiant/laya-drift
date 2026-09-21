type PartLike = {
  type?: string
  text?: string
  synthetic?: boolean
  tool?: string
  state?: {
    status?: string
    title?: string
    input?: Record<string, unknown>
    output?: unknown
  }
}

type MessageLike = {
  info?: { role?: string; id?: string; summary?: boolean }
  parts?: PartLike[]
}

type TodoLike = { content?: string; status?: string }

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim()
  if (clean.length <= max) return clean
  return `${clean.slice(0, max)}…`
}

function inputSummary(input: Record<string, unknown> | undefined): string {
  if (!input) return ""
  const keys = ["filePath", "path", "pattern", "command", "description", "query", "url", "prompt"]
  for (const key of keys) {
    const value = input[key]
    if (typeof value === "string" && value.trim()) return `${key}=${clip(value, 120)}`
  }
  const first = Object.entries(input).find(([, value]) => typeof value === "string")
  if (first) return `${first[0]}=${clip(String(first[1]), 100)}`
  return ""
}

function userText(message: MessageLike): string {
  return (message.parts ?? [])
    .filter((part) => part.type === "text" && !part.synthetic && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join(" ")
}

/** Calibration commands and drift status replies are monitor chatter, not work. */
export function isDriftChatter(message: MessageLike): boolean {
  // Structural: any turn that invoked a drift tool is calibration chatter,
  // regardless of how the model paraphrases its reply.
  if (
    (message.parts ?? []).some(
      (part) => part.type === "tool" && typeof part.tool === "string" && part.tool.startsWith("drift_"),
    )
  ) {
    return true
  }
  if (message.info?.role === "user") {
    return /The user invoked \/(calibrate|recalibrate|drift)\b/i.test(userText(message))
  }
  return false
}

function toolLine(part: PartLike): string | null {
  if (part.type !== "tool" || !part.tool) return null
  if (part.tool.startsWith("drift_")) return null
  const state = part.state ?? {}
  if (state.status && state.status !== "completed" && state.status !== "running") return null
  const detail = inputSummary(state.input) || clip(state.title ?? "", 100)
  return `TOOL ${part.tool}: ${detail || "called"}`
}

export function digestEntry(message: MessageLike): string | null {
  if (isDriftChatter(message)) return null
  const role = message.info?.role
  if (role === "user") {
    const text = clip(userText(message), 360)
    if (!text) return null
    return `USER: ${text}`
  }
  if (role === "assistant") {
    // Only tool actions are digested: assistant prose is verbose, stylistic
    // and noisy as a drift signal, while tool targets show what work happened.
    const tools = (message.parts ?? []).map(toolLine).filter((line): line is string => Boolean(line))
    return tools.length ? tools.slice(0, 6).join("\n") : null
  }
  return null
}

/** True when the session has work worth digesting (drift chatter does not count). */
export function hasSubstantiveActivity(messages: MessageLike[]): boolean {
  return messages.some((message) => digestEntry(message) !== null)
}

export type DigestInput = {
  anchor: string
  messages: MessageLike[]
  todos?: TodoLike[]
  budgetChars: number
}

/**
 * Canonical "work is following the plan" activity used to build the
 * calibration baseline. The baseline must use the same PLAN + RECENT ACTIVITY
 * structure as scoring states; without the positive exemplar the base
 * checkpoints answer structurally different questions for the baseline and
 * the divergences are dominated by that artifact instead of real drift.
 */
export const BASELINE_ACTIVITY =
  "USER: Implement the plan.\n" +
  "TOOL edit: filePath=the files named in the plan\n" +
  "AGENT: The work is exactly what the plan describes."

export function baselineState(anchor: string): string {
  return `PLAN:\n${clip(anchor, 900)}\n\nRECENT ACTIVITY (oldest to newest):\n${BASELINE_ACTIVITY}`
}

/**
 * The state text used for both calibration and scoring. Sessions without
 * substantive activity fall back to the positive exemplar so the structural
 * plan-vs-activity difference is never mistaken for drift.
 */
export function stateFor(input: DigestInput): string {
  if (!hasSubstantiveActivity(input.messages)) return baselineState(input.anchor)
  return buildDigest(input)
}

export function buildDigest(input: DigestInput): string {
  const parts: string[] = [`PLAN:\n${clip(input.anchor, 900)}`]

  const todos = (input.todos ?? [])
    .filter((todo) => todo.content && todo.status !== "completed" && todo.status !== "cancelled")
    .slice(0, 8)
  if (todos.length) {
    parts.push(`OPEN TASKS:\n${todos.map((todo) => `- [${todo.status ?? "pending"}] ${clip(todo.content ?? "", 90)}`).join("\n")}`)
  }

  const header = "RECENT ACTIVITY (oldest to newest):"
  const used = () => parts.join("\n\n").length + header.length + 2
  const entries: string[] = []
  for (let i = input.messages.length - 1; i >= 0; i -= 1) {
    const entry = digestEntry(input.messages[i]!)
    if (!entry) continue
    if (used() + entry.length > input.budgetChars && entries.length >= 2) break
    entries.push(entry)
  }
  entries.reverse()
  if (entries.length) parts.push(`${header}\n${entries.join("\n")}`)

  return parts.join("\n\n").slice(0, Math.max(600, input.budgetChars))
}

/** Fallback plan text when /calibrate is called without an explicit plan. */
export function derivePlan(messages: MessageLike[], todos?: TodoLike[]): string {
  const userTexts: string[] = []
  for (const message of messages) {
    if (message.info?.role !== "user") continue
    const text = clip(userText(message), 700)
    if (!text) continue
    if (/drift|calibrate|recalibrate/i.test(text)) continue
    userTexts.push(text)
    if (userTexts.length >= 2) break
  }
  const lines: string[] = []
  if (userTexts.length) lines.push(userTexts.join("\n---\n"))
  const open = (todos ?? [])
    .filter((todo) => todo.content && todo.status !== "completed" && todo.status !== "cancelled")
    .slice(0, 8)
    .map((todo) => `- ${clip(todo.content ?? "", 100)}`)
  if (open.length) lines.push(`Open tasks:\n${open.join("\n")}`)
  if (!lines.length) return "No explicit plan was provided. Treat the current session direction as the plan."
  return lines.join("\n\n")
}

/** Compact text of what happened since the last calibration, for /recalibrate. */
export function recentFocus(messages: MessageLike[], maxChars = 700): string {
  const entries: string[] = []
  for (let i = messages.length - 1; i >= 0 && entries.join("\n").length < maxChars; i -= 1) {
    const entry = digestEntry(messages[i]!)
    if (entry) entries.push(entry)
  }
  entries.reverse()
  return clip(entries.join("\n"), maxChars)
}
