/**
 * Candidate probe sets for the objective-grounding follow-up.
 *
 * The shipped probes ask "is the current state similar to the plan" — they
 * conflate exploration with drift. These sets ask about the *contribution* of
 * the recent activity to the objective instead, so the same trajectories can be
 * re-scored and compared on specificity.
 */
import { DRIFT_QUESTIONS } from "../../.opencode/drift/questions"
import type { QuestionDef } from "../../.opencode/drift/types"

export type ProbeSet = {
  id: string
  label: string
  hypothesis: string
  questions: Record<string, QuestionDef>
}

const OBJECTIVE_QUESTIONS: Record<string, QuestionDef> = {
  objective_support: {
    type: "choice",
    instructions: "Does the RECENT activity move the PLAN toward completion?",
    criteria: {
      advances: "the activity makes concrete progress on the plan",
      neutral: "the activity neither advances nor harms the plan",
      works_against: "the activity works against the plan",
    },
  },
  progress: {
    type: "choice",
    instructions: "How does the RECENT activity change the work that remains to finish the PLAN?",
    criteria: {
      reduces: "it reduces the remaining work",
      unchanged: "it leaves the remaining work unchanged",
      increases: "it increases the remaining work",
    },
  },
}

const CAUSAL_QUESTIONS: Record<string, QuestionDef> = {
  causal_link: {
    type: "choice",
    instructions: "How directly is the RECENT activity connected to the PLAN?",
    criteria: {
      direct: "it directly serves the plan",
      indirect: "it is related but only indirectly serves the plan",
      unrelated: "it is unrelated to the plan",
    },
  },
  plan_consistency: {
    type: "choice",
    instructions: "Is the agent still following the PLAN?",
    criteria: {
      following: "still following the plan",
      extending: "extending the plan beyond what it describes",
      departing: "departing from the plan",
    },
  },
}

const DYNAMICS_QUESTIONS: Record<string, QuestionDef> = {
  stuck: {
    type: "choice",
    instructions: "Is the RECENT activity making progress, repeating itself, or stuck?",
    criteria: {
      progressing: "the activity is making new progress",
      repeating: "the activity repeats earlier work without new progress",
      stuck: "the activity is stuck and not progressing at all",
    },
  },
  evidence: {
    type: "choice",
    instructions: "Does the RECENT activity contain evidence that part of the PLAN is complete?",
    criteria: {
      clear: "there is clear evidence that a part of the plan is complete",
      weak: "there is only weak or indirect evidence of completion",
      none: "there is no evidence that any part of the plan is complete",
    },
  },
}

export const PROBE_SETS: ProbeSet[] = [
  {
    id: "shipped",
    label: "shipped (alignment + plan_ref)",
    hypothesis: "reference: similarity-to-initial-state probes currently in drift.json",
    questions: DRIFT_QUESTIONS,
  },
  {
    id: "objective",
    label: "objective (support + progress)",
    hypothesis: "contribution probes: does the work advance the plan and reduce remaining work",
    questions: OBJECTIVE_QUESTIONS,
  },
  {
    id: "causal",
    label: "causal (link + consistency)",
    hypothesis: "grounding probes: is the work causally connected and still following the plan",
    questions: CAUSAL_QUESTIONS,
  },
  {
    id: "dynamics",
    label: "dynamics (stuck + evidence)",
    hypothesis: "observable-state probes: is the work progressing or thrashing, is there completion evidence",
    questions: DYNAMICS_QUESTIONS,
  },
  {
    id: "combined",
    label: "combined (all eight)",
    hypothesis: "contribution + grounding + dynamics together",
    questions: { ...DRIFT_QUESTIONS, ...OBJECTIVE_QUESTIONS, ...CAUSAL_QUESTIONS, ...DYNAMICS_QUESTIONS },
  },
]

export function probeSet(id: string): ProbeSet {
  const set = PROBE_SETS.find((candidate) => candidate.id === id)
  if (!set) throw new Error(`unknown probe set ${id}; known: ${PROBE_SETS.map((s) => s.id).join(", ")}`)
  return set
}
