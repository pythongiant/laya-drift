export type ChoiceAnswer = {
  type: "choice"
  choice: string
  probabilities: Record<string, number>
  confidence: number
  action?: { act_probability: number }
}

export type ScoreAnswer = {
  type: "score"
  score: number
  legend: Record<string, string>
  probabilities: Record<string, number>
  confidence: number
  action?: { act_probability: number }
}

export type NoulAnswer = {
  type: "noul"
  noul: number
  confidence: number
  action?: { act_probability: number }
}

export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer

export type LayaResponse = {
  ok: boolean
  model?: string
  checkpoint?: string
  answers?: Record<string, Answer>
  usage?: { input_tokens: number; output_tokens: number }
  elapsed_ms?: number
  error?: string
  loading?: boolean
}

export type DriftBand = "on-plan" | "slight" | "drifting" | "off-plan" | "unknown"

export type DriftHistoryEntry = {
  at: number
  score: number
  delta: number
  top: string
  trigger: string
  /** SDM v2 risk score (0-100) at this point, when available. */
  risk?: number
}

export type RiskSignals = { js: number; flip: number; noul: number }

export type DriftState = {
  sessionID: string
  directory?: string
  version: number
  calibratedAt: number
  anchor: string
  anchorHistory: string[]
  baseline: Record<string, number[]>
  /** Calibrated before any work: anchor on the first substantive activity instead. */
  awaitingFirstActivity?: boolean
  score: number
  previousScore: number
  band: DriftBand
  top: string
  perQuestion: Record<string, number>
  history: DriftHistoryEntry[]
  modelCheckpoint: string
  updatedAt: number
  /** Fixed reference window (first substantive turns) for the SDM signals. */
  sdmWindow?: Array<Record<string, number[]>>
  /** SDM v2 risk score (0-100): failure-risk ranking signal, not a probability. */
  risk?: number
  /** e-process log evidence accumulated from the SDM signals. */
  riskLogE?: number
  riskSignals?: RiskSignals
}

export type DriftResult = {
  score: number
  delta: number
  band: DriftBand
  top: string
  perQuestion: Record<string, number>
  at: number
  risk?: number
  riskSignals?: RiskSignals
}

export type QuestionKind = "choice" | "score" | "noul"

export type QuestionDef =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "noul"; instructions: string }
