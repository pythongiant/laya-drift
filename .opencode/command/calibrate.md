---
description: Calibrate the drift baseline from the original plan
---
The user invoked /calibrate. Call the `drift_calibrate` tool exactly once.

- If arguments were given, pass them verbatim as the `plan` argument: $ARGUMENTS
- If no arguments were given, call `drift_calibrate` without a plan argument so it derives the plan from the session.

Then reply with only the status line the tool returned. Do not use any other tools and do not add commentary.
