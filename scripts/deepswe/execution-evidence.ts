/**
 * Observable execution evidence extracted from tool use.
 *
 * Shared by evidence.ts (offline analysis) and run.ts (the evidence-triggered
 * intervention arm). Covers both structured tools and bash-mediated edits, so
 * `git apply` / `sed -i` / redirects count as work the same way `write` does.
 */
export type ToolUse = { name: string; args: Record<string, unknown>; output: string }

export const TEST_RE =
  /\b(pytest|unittest|go test|cargo test|npm test|npm run test|yarn test|pnpm test|bun test|vitest|jest)\b/
export const ERROR_RE = /(^|\n)(ERROR:|Traceback \(most recent call last\)|exit [1-9]|command timed out)/

const FILE_PATTERNS = [
  /git apply[^|;&]*?\s([\w./-]+\.(?:py|js|ts|tsx|jsx|go|rs|toml|json|md|txt|cfg|ini|yml|yaml))\b/g,
  /\bpatch\b[^|;&]*?<\s*([\w./-]+)/g,
  /\bsed\s+-i\b[^|;&]*?\s([\w./-]+)/g,
  /\btee\s+(?:-a\s+)?([\w./-]+)/g,
  /(?:^|[;&|]\s*)(?:cat|printf|echo|python3?|node)\b[^|;&]*?>{1,2}\s*([\w./-]+)/g,
]

/** File paths a shell command writes, including patch/sed/redirect forms. */
export function bashFileTargets(command: string): string[] {
  const targets: string[] = []
  for (const pattern of FILE_PATTERNS) {
    for (const match of command.matchAll(pattern)) {
      const path = match[1]
      if (path && path !== "/dev/null") targets.push(path)
    }
  }
  return targets
}

const TEST_FILE_RE = /(^|\/)(test_|tests?\/).*\.(py|js|ts|tsx|go|rs)$|_test\.(py|js|ts|tsx|go|rs)$/

export function looksLikeTestFile(path: string): boolean {
  return TEST_FILE_RE.test(path)
}

export type TurnEvidence = {
  files: string[]
  testsRun: number
  maxTestsPassed: number
  lastTestsFailed: number
  errors: number
  toolCalls: number
}

export function summarizeTurn(tools: ToolUse[]): TurnEvidence {
  const files: string[] = []
  let testsRun = 0
  let maxTestsPassed = 0
  let lastTestsFailed = 0
  let errors = 0
  for (const tool of tools) {
    if (ERROR_RE.test(tool.output)) errors += 1
    if (tool.name === "write" || tool.name === "edit") {
      const path = String(tool.args.path ?? "")
      if (path) files.push(path)
    }
    if (tool.name === "bash") {
      const command = String(tool.args.command ?? "").replace(/\s+/g, " ").trim()
      files.push(...bashFileTargets(command))
      if (TEST_RE.test(command)) testsRun += 1
      const passed = [...tool.output.matchAll(/(\d+) passed/g)].map((match) => Number(match[1]))
      const failed = [...tool.output.matchAll(/(\d+) failed/g)].map((match) => Number(match[1]))
      if (passed.length) maxTestsPassed = Math.max(maxTestsPassed, ...passed)
      if (failed.length) lastTestsFailed = Math.max(...failed)
    }
  }
  return { files, testsRun, maxTestsPassed, lastTestsFailed, errors, toolCalls: tools.length }
}
