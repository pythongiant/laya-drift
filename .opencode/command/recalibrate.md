---
description: Re-anchor the drift baseline with the previous baseline plus new context
---
The user invoked /recalibrate. Call the `drift_recalibrate` tool exactly once.

- If arguments were given, pass them verbatim as the `context` argument: $ARGUMENTS
- If no arguments were given, call `drift_recalibrate` without arguments so it folds in the recent activity.

Then reply with only the status line the tool returned. Do not use any other tools and do not add commentary.
