/**
 * Adapters between the experiment's chat transcript format and the drift
 * digest's message format. Shared by run.ts (live scoring) and reprobe.ts
 * (offline re-scoring from transcripts).
 */
export type DriftMessage = { info: { role: string }; parts: Array<Record<string, unknown>> }

export type ToolCall = { id: string; type: string; function: { name: string; arguments: string } }

export function driftUser(text: string): DriftMessage {
  return { info: { role: "user" }, parts: [{ type: "text", text }] }
}

export function driftAssistant(toolCalls: ToolCall[]): DriftMessage {
  const parts = toolCalls.map((call) => {
    let input: Record<string, unknown> = {}
    try {
      input = JSON.parse(call.function.arguments) as Record<string, unknown>
    } catch {
      input = { raw: call.function.arguments }
    }
    return { type: "tool", tool: call.function.name, state: { status: "completed", input } }
  })
  return { info: { role: "assistant" }, parts }
}
