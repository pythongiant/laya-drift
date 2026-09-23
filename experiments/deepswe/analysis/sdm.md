# Semantic Drift Monitor v2 (detection only)

Generated 2026-09-23T11:45:41.868Z · 42 runs re-scored (30 DeepSWE, 12 mutants) · Laya multilingual

Signals per turn, all from one Laya pass over 5 choice + 2 `noul` probes:

- `js` — mean JS divergence vs the reference window (first 3 turns)
- `flip` — fraction of probes whose answer changed vs the window majority
- `noul` — mean absolute shift of the calibrated `noul` probabilities
- `combined` — mean of the three, each standardized on null runs

## Injected plan-departure detection (distractor runs with transcripts)

| monitor | TPR | FPR | median delay |
| --- | --- | --- | --- |
| shipped v1 (single probes, tau=35) | 0.67 (2/3) | 0.78 (14/18) | 1.0 |
| SDM js fixed (null mean + 3 sd) | 0.00 (0/3) | 0.06 (1/18) | n/a |
| SDM flip fixed (null mean + 3 sd) | 0.00 (0/3) | 0.00 (0/18) | n/a |
| SDM noul fixed (null mean + 3 sd) | 0.00 (0/3) | 0.11 (2/18) | n/a |
| SDM combined fixed (null mean + 3 sd) | 0.00 (0/3) | 0.00 (0/18) | n/a |
| SDM e-process on combined, alpha=0.2 | 0.33 (1/3) | 0.22 (4/18) | 10.0 |
| SDM e-process on combined, alpha=0.1 | 0.00 (0/3) | 0.17 (3/18) | n/a |
| SDM e-process on combined, alpha=0.05 | 0.00 (0/3) | 0.06 (1/18) | n/a |
| SDM e-process on combined, alpha=0.01 | 0.00 (0/3) | 0.00 (0/18) | n/a |

Null-run average run length (e-process): alpha=0.2: 12.4 · alpha=0.1: 12.9 · alpha=0.05: 13.3 · alpha=0.01: 13.3 turns.

## Failure prediction on the mutant corpus

| signal | early-max AUC |
| --- | --- |
| SDM js | 0.594 |
| SDM flip | 0.859 |
| SDM noul | 0.688 |
| SDM combined | 0.906 |
| SDM combined-z | 0.844 |
| shipped v1 | 0.563 |

Execution-evidence baseline from the main report: AUC 0.969.

![SDM e-process](plots/sdm-eprocess.svg)

![SDM vs v1](plots/sdm-compare.svg)
