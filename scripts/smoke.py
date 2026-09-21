#!/usr/bin/env python3
"""Direct Laya smoke test: scores a plan state and a drifted state with the
same question set the plugin uses, so you can sanity-check the signal before
wiring it into opencode.

Usage:
    .venv/bin/python scripts/smoke.py [--checkpoint multilingual]
"""

from __future__ import annotations

import argparse
import json
import os
import sys

os.environ.setdefault("USE_TF", "0")

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

QUESTIONS = {
    "alignment": {
        "type": "choice",
        "instructions": "Compare the PLAN with the RECENT activity. Are they the same piece of work?",
        "criteria": {
            "on_plan": "recent activity directly serves the plan",
            "expanding": "related to the plan but growing beyond it",
            "off_plan": "unrelated to the plan",
        },
    },
    "plan_fidelity": {
        "type": "score",
        "instructions": "How tightly does the RECENT activity follow the PLAN?",
        "criteria": ["loosely", "partly", "closely"],
    },
    "goal_changed": {
        "type": "noul",
        "instructions": "Has the goal changed so much that the PLAN no longer describes the current work?",
    },
    "scope_creep": {
        "type": "noul",
        "instructions": "Does the RECENT activity go beyond the scope of the PLAN?",
    },
    "task_switch": {
        "type": "noul",
        "instructions": "Has the work switched to a different primary task or subject than the PLAN?",
    },
}

PLAN = """PLAN:
Add a /health endpoint to the FastAPI service and cover it with a pytest
test that asserts a 200 response with {"status": "ok"}."""

ON_PLAN = PLAN + """

RECENT ACTIVITY (oldest to newest):
USER: Implement the health route per the plan.
TOOL edit: filePath=app/routes/health.py
AGENT: Added the route and registered it in main.py.
TOOL bash: command=pytest tests/test_health.py
AGENT: The new test passes."""

DRIFTED = PLAN + """

RECENT ACTIVITY (oldest to newest):
USER: While you are in there, rewrite the whole auth layer.
TOOL edit: filePath=auth/session.py
TOOL edit: filePath=auth/oauth.py
AGENT: Replaced the session store with Redis and migrated OAuth providers.
TOOL bash: command=alembic upgrade head
AGENT: Also cleaned up the deployment pipeline so Redis is provisioned."""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", default="multilingual", choices=["english", "multilingual", "typed-decisions"])
    args = parser.parse_args()

    import laya

    subfolder = None if args.checkpoint == "english" else args.checkpoint
    agent = laya.load("convaiinnovations/laya", subfolder=subfolder)
    print(f"device: {agent.device}")

    for name, state in (("on-plan", ON_PLAN), ("drifted", DRIFTED)):
        result = agent.predict(state, QUESTIONS)
        answers = result["answers"]
        print(f"\n=== {name} ===")
        print("alignment   ", answers["alignment"]["probabilities"], f"-> {answers['alignment']['choice']}")
        print("plan_fidelity", answers["plan_fidelity"]["probabilities"], f"-> {answers['plan_fidelity']['score']}")
        print("goal_changed ", answers["goal_changed"]["noul"])
        print("scope_creep  ", answers["scope_creep"]["noul"])
        print("task_switch  ", answers["task_switch"]["noul"])
        print("usage        ", result["usage"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
