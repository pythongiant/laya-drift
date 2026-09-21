/**
 * Prints the raw Laya answers for the eval fixtures so you can see why the
 * drift math behaves the way it does.
 *
 *   bun scripts/inspect.ts
 */
import { loadConfig } from "../.opencode/drift/config"
import { DRIFT_QUESTIONS } from "../.opencode/drift/questions"
import { scoreWithLaya } from "../.opencode/drift/daemon"

const directory = new URL("..", import.meta.url).pathname.replace(/\/$/, "")
const config = loadConfig(directory)

const PLAN = `PLAN:
Add a /health endpoint to the FastAPI service and cover it with a pytest test
that asserts a 200 response with {"status": "ok"}.`

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

for (const [name, state] of [["PLAN", PLAN], ["ON_PLAN", ON_PLAN], ["DRIFTED", DRIFTED]] as const) {
  const response = await scoreWithLaya(config, state, DRIFT_QUESTIONS)
  console.log(`\n=== ${name} (${response.elapsed_ms}ms, tokens=${response.usage?.input_tokens}) ===`)
  for (const [id, answer] of Object.entries(response.answers ?? {})) {
    if (answer.type === "choice") console.log(`${id}: ${answer.choice} ${JSON.stringify(answer.probabilities)}`)
    else if (answer.type === "score") console.log(`${id}: ${answer.score} ${JSON.stringify(answer.probabilities)}`)
    else console.log(`${id}: noul=${answer.noul}`)
  }
}
