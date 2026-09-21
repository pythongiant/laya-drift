import type { QuestionDef } from "./types"

export const QUESTIONS_VERSION = 2

/**
 * The probe set used to embed a session state. Laya answers every question in
 * one forward pass and the calibrated distribution over each question's
 * options becomes the vector compared against the baseline.
 *
 * These two questions were chosen empirically (see scripts/experiment.ts):
 * noul and ordinal-score probes from the base checkpoints proved degenerate
 * zero-shot (near-constant answers), while these track the fixture ordering
 * on-plan < drifted < off-plan with clear margins.
 */
export const DRIFT_QUESTIONS: Record<string, QuestionDef> = {
  alignment: {
    type: "choice",
    instructions: "Compare the PLAN with the RECENT activity. Are they the same piece of work?",
    criteria: {
      on_plan: "recent activity directly serves the plan",
      expanding: "related to the plan but growing beyond it",
      off_plan: "unrelated to the plan",
    },
  },
  plan_ref: {
    type: "choice",
    instructions: "Which statement best describes the RECENT activity relative to the PLAN?",
    criteria: {
      doing_the_plan: "doing what the plan describes",
      doing_more: "doing the plan plus extra work",
      doing_other: "doing something else entirely",
    },
  },
}

export const QUESTION_ORDER = Object.keys(DRIFT_QUESTIONS)

export function questionLabel(id: string): string {
  switch (id) {
    case "alignment":
      return "plan alignment"
    case "plan_ref":
      return "plan reference"
    default:
      return id
  }
}
