---
description: Drift over time as a text graph (session or repo)
---
The user invoked /drift-report. Call the `drift_history` tool exactly once.

- If the arguments mention "repo" or "all sessions", call it with scope="repo".
- Otherwise call it without arguments (current session).
- Arguments were: $ARGUMENTS

Then reply with the tool output verbatim inside a code block. Do not use any other tools and do not add commentary.
