# opencode-drift

Semantic drift monitor for opencode sessions. It embeds the session state with
[Laya](https://huggingface.co/convaiinnovations/laya) — a non-autoregressive
decision model that returns **calibrated probability distributions** for typed
questions in a single forward pass — and measures how far the running context
has moved from the calibrated plan.

- `/calibrate` captures the plan (argument or derived from the session) and sets
  the drift baseline.
- Every user prompt and every finished turn re-embeds the running context and
  recomputes drift. Tool calls inside a turn do not rescore.
- The live score renders as a pill in the session sidebar (`sidebar_content`) and
  as a compact badge next to the prompt (`session_prompt_right`). Color rule:
  scores **below 50 are green, 50 and above are red** (`scoreColor` in
  `drift.tui.tsx`).
  Toasts still announce band changes and threshold crossings.
- `/recalibrate` re-anchors: the previous anchor plus new context becomes the
  new baseline, and drift resets to zero.

## How the score works

Laya is used purely as a semantic proxy. A probe of two typed questions
(`.opencode/drift/questions.ts`) is answered against the session state:

| question | type | weight |
| --- | --- | --- |
| `alignment` (on_plan / expanding / off_plan) | choice | 0.6 |
| `plan_ref` (doing_the_plan / doing_more / doing_other) | choice | 0.4 |

Each answer is a calibrated probability distribution. The baseline is built at
calibration time from the **current state digest** — the same `PLAN` +
`RECENT ACTIVITY` structure used for scoring — so drift is measured from the
moment of calibration onward. If the session has no activity yet, the baseline
uses a canonical "the work follows the plan" exemplar instead (plan-alone
states answer structurally different questions on the base checkpoints).

That is also why `/recalibrate` resets to zero and stays there: the previous
anchor plus the new context become the new anchor, and the state at that moment
becomes the zero point. Only divergence that happens *after* recalibration
raises the score.

Every score compares the current vector to the baseline with Jensen-Shannon
divergence, takes the weighted mean, and maps it through a saturating curve:

```
drift = 100 · (1 - e^( -sensitivity · Σ wᵢ · JS(baselineᵢ, currentᵢ) / Σ wᵢ ))
```

Bands: `<20` on-plan, `<40` slight, `<65` drifting, `≥65` off-plan. Above
`display.injectSystemAbove` the score is also injected into the system prompt so
the agent can self-correct.

The probe set was chosen empirically, not by taste: `scripts/experiment.ts`
and `scripts/baseline-probe3.ts` show how other framings (noul statements,
ordinal score questions, baseline without an exemplar) collapse to
near-constant answers on the base checkpoints, which is why they are not used.

## Layout

```
opencode.json                      project config (plugins auto-load from .opencode/plugins)
.opencode/
  drift.json                       tunables (weights, thresholds, daemon, stateDir)
  tui.json                         registers the live-score TUI plugin
  package.json                     JS deps for the plugins (bun installed by opencode)
  command/{calibrate,recalibrate,drift}.md
  plugins/drift.server.ts          server plugin: tools, hooks, scoring, toasts
  plugins/drift.tui.tsx            TUI plugin: live score next to the prompt
  drift/                           shared core (questions, embedding, divergence, digest, store)
src/driftd.py                      Laya HTTP daemon (model resident)
scripts/setup.sh                   venv + laya install
scripts/smoke.py                   direct Laya sanity check
scripts/eval.ts                    end-to-end signal check against the daemon
scripts/session-test.ts            calibrate → score → recalibrate flow with mocked messages
scripts/experiment.ts              question/weight experiments (dev)
scripts/baseline-probe*.ts         baseline framing experiments (dev)
```

## Setup

```bash
cd /Users/srihariunnikrishnan/drift
bash scripts/setup.sh              # .venv (reuses system torch) + pip install laya
(cd .opencode && bun install)      # or npm install
```

The venv uses `--system-site-packages`, so the existing torch/transformers
install is reused instead of downloading another copy.

First run downloads the checkpoint (`multilingual`, ~650 MB). To warm it up
manually:

```bash
.venv/bin/python src/driftd.py --port 8765 --checkpoint multilingual
```

The server plugin autostarts the daemon on first calibration if it is not
already listening, and reports progress in the toast/log.

Then, inside this project:

```bash
opencode
/calibrate Build the CSV importer with the schema in docs/plan.md
...work...
/recalibrate We intentionally moved to the streaming rewrite
/drift
```

## Configuration

`.opencode/drift.json` is read by both plugins:

- `daemon`: `port`, `checkpoint` (`english` 512 ctx / `multilingual` 1024 ctx /
  `typed-decisions`), `device`, `python`, `autostart`, `startTimeoutMs`.
- `scoring`: `sensitivity` (how fast divergence saturates 100), `minIntervalMs`
  (scoring throttle), `digestChars` (context window sent to Laya), `weights`.
- `display`: `toastMode` (`changes` | `always` | `off`), `warnThreshold`,
  `alertThreshold`, `injectSystemAbove` (set `null` to disable system
  injection).
- `stateDir`: where per-session state is written for the TUI to read
  (default `~/.local/share/opencode-drift`).

## Testing

```bash
bunx tsc --noEmit                  # typecheck plugins
.venv/bin/python scripts/smoke.py  # raw Laya sanity check
bun scripts/eval.ts                # full pipeline vs the running daemon
bun scripts/session-test.ts        # calibrate/score/recalibrate flow
```

`scripts/eval.ts` embeds a plan, an on-plan update and a drifted update, then
verifies the drifted state scores strictly higher. `scripts/session-test.ts`
drives the controller with mocked session messages and asserts calibration,
scoring, history and the recalibration reset. Last measured: on-plan `2.7`,
drifted `36.1`, back on the new baseline after `/recalibrate` `11.7`.

## Honest limits

- Laya ships over-confident, and its base checkpoints are weak zero-shot on
  custom typed questions. The two probes here were picked because they
  separate on-plan / drifted / off-plan states on the fixtures; they are a
  semantic proxy, not a calibrated probability of failure.
- The English checkpoint has a 512-token context (`multilingual` gets 1024);
  the digest keeps only the anchor plus the newest activity that fits. Long
  autonomous runs can push relevant older context out of the window.
- The `multilingual` checkpoint is the default because of the larger context
  and 2.2× faster inference; switch `daemon.checkpoint` to `english` for a
  better English-only encoder (the daemon downloads only the requested
  checkpoint).
- Scoring runs locally and adds ~50–300 ms per update on Apple Silicon (MPS).
  Set `scoring.minIntervalMs` higher if that matters.
