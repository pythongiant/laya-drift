/**
 * Question-design probe: tries several phrasings and prints the answer
 * distributions across five fixture states, so we can pick probes that
 * actually track plan-vs-drift rather than model artifacts.
 *
 *   bun scripts/probe.ts
 */
import { loadConfig } from "../.opencode/drift/config"
import { scoreWithLaya } from "../.opencode/drift/daemon"
import type { QuestionDef } from "../.opencode/drift/types"

const directory = new URL("..", import.meta.url).pathname.replace(/\/$/, "")
const config = loadConfig(directory)

const PLAN = `PLAN:
Add a /health endpoint to the FastAPI service and cover it with a pytest test
that asserts a 200 response with {"status": "ok"}.`

const NONE = `${PLAN}

RECENT ACTIVITY (oldest to newest):
(nothing yet — work is about to start)`

const ON_PLAN = `${PLAN}

RECENT ACTIVITY (oldest to newest):
USER: Implement the health route per the plan.
TOOL edit: filePath=app/routes/health.py
AGENT: Added the route and registered it in main.py.
TOOL bash: command=pytest tests/test_health.py
AGENT: The new test passes.`

const DRIFTED = `${PLAN}

RECENT ACTIVITY (oldest to newest):
USER: While you are in there, rewrite the whole auth layer.
TOOL edit: filePath=auth/session.py
TOOL edit: filePath=auth/oauth.py
AGENT: Replaced the session store with Redis and migrated OAuth providers.
TOOL bash: command=alembic upgrade head
AGENT: Also cleaned up the deployment pipeline so Redis is provisioned.`

const OFF_PLAN = `${PLAN}

RECENT ACTIVITY (oldest to newest):
USER: Forget that, the marketing site needs a redesign.
TOOL edit: filePath=web/home.css
TOOL edit: filePath=web/index.tsx
AGENT: Renamed all CSS classes and rewrote the homepage copy.`

const QUESTIONS: Record<string, QuestionDef> = {
  align_orig: {
    type: "choice",
    instructions: "Compare the PLAN with the RECENT activity. Are they the same piece of work?",
    criteria: {
      on_plan: "recent activity directly serves the plan",
      expanding: "related to the plan but growing beyond it",
      off_plan: "unrelated to the plan",
    },
  },
  align_v2: {
    type: "choice",
    instructions: "Does the RECENT activity follow the PLAN?",
    criteria: {
      follows: "it does what the plan says",
      expands: "it adds work the plan does not mention",
      abandons: "it leaves the plan and does something else",
    },
  },
  focus_v2: {
    type: "choice",
    instructions: "Which task is the RECENT activity about?",
    criteria: {
      planned_task: "the task described in the plan",
      related_task: "a task adjacent to the planned task",
      different_task: "a task unrelated to the plan",
    },
  },
  scope_v2: {
    type: "choice",
    instructions: "Is the RECENT activity within the scope of the PLAN?",
    criteria: {
      within: "everything is in the plan",
      slightly_beyond: "partly outside the plan",
      well_beyond: "mostly outside the plan",
    },
  },
  goal_v2: {
    type: "choice",
    instructions: "Is the goal of the RECENT activity the same as the goal of the PLAN?",
    criteria: {
      same_goal: "identical goal",
      related_goal: "a related but different goal",
      different_goal: "a completely different goal",
    },
  },
  noul_statement: {
    type: "noul",
    instructions: "The RECENT activity is unrelated to the PLAN.",
  },
  same_subject: {
    type: "noul",
    instructions: "The RECENT activity works on the same subject as the PLAN.",
  },
  deviation: {
    type: "score",
    instructions: "How far has the RECENT activity moved away from the PLAN?",
    criteria: ["not at all", "slightly", "moderately", "far", "completely"],
  },
  deviation_v2: {
    type: "score",
    instructions: "How much does the RECENT activity deviate from the PLAN?",
    criteria: ["not at all", "a little", "somewhat", "a lot", "totally"],
  },
  task_match: {
    type: "score",
    instructions: "How much of the RECENT activity is about the task described in the PLAN?",
    criteria: ["none of it", "some of it", "all of it"],
  },
  still_plan: {
    type: "score",
    instructions: "Is the RECENT activity still following the PLAN?",
    criteria: ["no", "mostly no", "mostly yes", "yes"],
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

const states: Record<string, string> = {
  PLAN,
  NONE,
  ON_PLAN,
  DRIFTED,
  OFF_PLAN,
}

const responses: Record<string, Awaited<ReturnType<typeof scoreWithLaya>>> = {}
for (const [name, state] of Object.entries(states)) {
  responses[name] = await scoreWithLaya(config, state, QUESTIONS)
}

const ids = Object.keys(QUESTIONS)
const header = ["state".padEnd(10), ...ids.map((id) => id.padEnd(30))].join(" ")
console.log(header)
for (const state of Object.keys(states)) {
  const answers = responses[state]?.answers ?? {}
  const cells = ids.map((id) => {
    const answer = answers[id]
    if (!answer) return "?".padEnd(30)
    if (answer.type === "choice") {
      const top = Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1])[0]!
      return `${top[0]}=${top[1].toFixed(2)}`.padEnd(30)
    }
    if (answer.type === "score") return `score=${answer.score}`.padEnd(30)
    return `noul=${answer.noul}`.padEnd(30)
  })
  console.log([state.padEnd(10), ...cells].join(" "))
}
