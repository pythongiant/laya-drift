import { tool } from "@opencode-ai/plugin"
import type { Plugin } from "@opencode-ai/plugin"
import { loadConfig } from "../drift/config"
import type { DriftConfig } from "../drift/config"
import { calibrate, recalibrate, reportText, repoGraph, scoreSession, sessionGraph, statusText } from "../drift/controller"
import { checkHealth } from "../drift/daemon"
import { readState, removeState } from "../drift/store"
import { bandGlyph } from "../drift/embed"
import type { DriftResult, DriftState } from "../drift/types"

type LogLevel = "debug" | "info" | "warn" | "error"

function makeLogger(client: { app: { log: (args: unknown) => Promise<unknown> } }, directory: string) {
  return (level: LogLevel, message: string, extra?: unknown) => {
    void client.app
      .log({ body: { service: "laya-drift", level, message, extra: extra ? { directory, ...(extra as object) } : { directory } } })
      .catch(() => undefined)
  }
}

function toast(
  client: { tui: { showToast: (args: unknown) => Promise<unknown> } },
  message: string,
  variant: "info" | "success" | "warning" | "error",
  duration = 5000,
) {
  void client.tui.showToast({ body: { title: "laya-drift", message, variant, duration } }).catch(() => undefined)
}

function variantFor(band: DriftState["band"]): "info" | "success" | "warning" | "error" {
  switch (band) {
    case "on-plan":
      return "success"
    case "slight":
      return "info"
    case "drifting":
      return "warning"
    default:
      return "error"
  }
}

export const DriftPlugin: Plugin = async ({ client, directory }) => {
  const config: DriftConfig = loadConfig(directory)
  const log = makeLogger(client as never, directory)

  const handleScore = async (sessionID: string, trigger: string, force = false, extraText?: string) => {
    const before = config.display.slot || config.display.toastMode !== "off" ? readState(config.stateDir, sessionID) : null
    const result: DriftResult | null = await scoreSession({
      client: client as never,
      directory,
      config,
      log,
      sessionID,
      trigger,
      force,
      extraText,
    })
    if (!result) return
    if (config.display.toastMode === "always") {
      toast(client as never, `${result.score.toFixed(0)}/100 ${bandGlyph(result.band)} ${result.band}${result.delta ? ` (${result.delta > 0 ? "+" : ""}${result.delta.toFixed(0)})` : ""}`, variantFor(result.band))
      return
    }
    if (config.display.toastMode !== "changes") return
    const bandChanged = before ? before.band !== result.band : false
    const crossedWarn = !before || (before.score < config.display.warnThreshold && result.score >= config.display.warnThreshold)
    const crossedAlert = !before || (before.score < config.display.alertThreshold && result.score >= config.display.alertThreshold)
    if (crossedAlert) {
      toast(client as never, `drift ${result.score.toFixed(0)}/100 — off plan (${result.top})`, "error", 8000)
    } else if (crossedWarn) {
      toast(client as never, `drift ${result.score.toFixed(0)}/100 — drifting (${result.top})`, "warning", 6000)
    } else if (bandChanged) {
      toast(client as never, `drift ${result.score.toFixed(0)}/100 — ${result.band}`, variantFor(result.band))
    }
  }

  return {
    tool: {
      drift_calibrate: tool({
        description:
          "Calibrate the semantic drift baseline for this session from the original plan. Call this when the user runs /calibrate.",
        args: {
          plan: tool.schema
            .string()
            .optional()
            .describe("The original plan or goal text; omit to derive it from the session so far"),
        },
        async execute(args, context) {
          const health = await checkHealth(config)
          if (!health?.ready) {
            toast(client as never, "loading the Laya checkpoint (first run downloads it)", "info", 8000)
          }
          const state = await calibrate({
            client: client as never,
            directory,
            config,
            log,
            sessionID: context.sessionID,
            plan: args.plan,
          })
          toast(client as never, `baseline calibrated · drift reset to 0`, "success")
          return `Drift baseline calibrated.\n${reportText(state)}`
        },
      }),
      drift_recalibrate: tool({
        description:
          "Re-anchor the drift baseline: keeps the previous anchor and folds in new context, then resets drift to zero. Call this when the user runs /recalibrate.",
        args: {
          context: tool.schema
            .string()
            .optional()
            .describe("New direction or context to accept as the updated baseline; omit to use recent activity"),
        },
        async execute(args, context) {
          const health = await checkHealth(config)
          if (!health?.ready) {
            toast(client as never, "loading the Laya checkpoint (first run downloads it)", "info", 8000)
          }
          const state = await recalibrate({
            client: client as never,
            directory,
            config,
            log,
            sessionID: context.sessionID,
            plan: args.context,
          })
          toast(client as never, `baseline re-anchored · drift reset to 0`, "success")
          return `Drift baseline re-anchored.\n${reportText(state)}`
        },
      }),
      drift_status: tool({
        description: "Show the current semantic drift score for this session. Call this when the user runs /drift.",
        args: {},
        async execute(_args, context) {
          const state = readState(config.stateDir, context.sessionID)
          if (!state) return "Drift monitor is not calibrated for this session yet. Run /calibrate first."
          return reportText(state)
        },
      }),
      drift_history: tool({
        description:
          "Render drift over time as a text graph, for this session or the whole repository. Call this when the user runs /drift-graph.",
        args: {
          scope: tool.schema
            .enum(["session", "repo"])
            .optional()
            .describe("session (default) or repo (every session in this project, merged by time)"),
        },
        async execute(args, context) {
          if (args.scope === "repo") return repoGraph(directory, config)
          const state = readState(config.stateDir, context.sessionID)
          if (!state) return "Drift monitor is not calibrated for this session yet. Run /calibrate first."
          return sessionGraph(state, config)
        },
      }),
    },

    "chat.message": async (input, output) => {
      const text = (output.parts ?? [])
        .filter((part) => part.type === "text" && !part.synthetic)
        .map((part) => (part.type === "text" ? part.text : ""))
        .join(" ")
      // chat.message fires before the prompt is persisted; score shortly after
      // so the digest sees it (extraText covers the gap).
      setTimeout(() => void handleScore(input.sessionID, "prompt", false, text), 2000)
    },

    event: async ({ event }) => {
      if (event.type === "session.created") {
        // Every new session starts with no drift state.
        const sessionID = (event.properties as { info?: { id?: string } } | undefined)?.info?.id
        if (sessionID) removeState(config.stateDir, sessionID)
      }
      if (event.type === "message.updated") {
        // Turn-end trigger that also fires for headless `opencode run`
        // sessions, where session.idle never arrives.
        const info = (event.properties as {
          info?: { role?: string; sessionID?: string; time?: { completed?: number } }
        } | undefined)?.info
        if (info?.role === "assistant" && info.time?.completed && info.sessionID) {
          await handleScore(info.sessionID, "turn", true)
        }
      }
      if (event.type === "session.idle") {
        const sessionID = (event.properties as { sessionID?: string } | undefined)?.sessionID
        if (sessionID) await handleScore(sessionID, "turn", true)
      }
      if (event.type === "session.deleted") {
        const sessionID = (event.properties as { info?: { id?: string }; sessionID?: string } | undefined)?.sessionID ??
          (event.properties as { info?: { id?: string } } | undefined)?.info?.id
        if (sessionID) removeState(config.stateDir, sessionID)
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      const threshold = config.display.injectSystemAbove
      if (threshold === null || !input.sessionID) return
      const state = readState(config.stateDir, input.sessionID)
      if (!state || state.updatedAt === 0) return
      if (state.score < threshold) return
      output.system.push(
        `[drift-monitor] Semantic drift from the calibrated plan is ${state.score.toFixed(0)}/100 (${state.band}; top driver: ${state.top}). ` +
          `Stay on the calibrated plan. If the user has clearly changed direction, say so and suggest /recalibrate.`,
      )
    },
  }
}

export default DriftPlugin
