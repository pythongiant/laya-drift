# Execution-evidence features vs semantic drift

Generated 2026-09-23T07:00:40.113Z · 30 runs with transcripts · early window = first 80% of turns

Reference: shipped semantic probe early max drift AUC = **0.593**; pre-registered combined evidence score AUC = **0.951**.

Caveat: every solved run in this corpus is an oracle run (it applies the reference patch), and
only oracle runs execute tests. The perfect test-feature AUC therefore measures the success
mechanism itself, not an independent predictor. Bash-mediated edits (`git apply`, `sed -i`,
redirects) are parsed here, but the structured-tool-only version of this feature missed them
entirely — an action-normalization warning for any evidence layer.

Selection caveat: the combined score's weights were chosen after inspecting these same runs,
so 0.926 is optimistic. The robust part is univariate: test execution is binary present/absent.

| run | reward | tests (early) | tests (full) | passed (full) | files (early) | files (full) | patch lines |
| --- | --- | --- | --- | --- | --- | --- | --- |
| mashumaro-flattened-dataclass-fields__control__r2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| mashumaro-flattened-dataclass-fields__distractor__r2 | 0 | 0 | 0 | 0 | 1 | 1 | 217 |
| mashumaro-flattened-dataclass-fields__guided__r1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| mashumaro-flattened-dataclass-fields__guided__r2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| mashumaro-flattened-dataclass-fields__intervene__r1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| mashumaro-flattened-dataclass-fields__intervene__r2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| mashumaro-flattened-dataclass-fields__oracle__r1 | 1 | 5 | 5 | 30339 | 0 | 1 | 542 |
| mashumaro-flattened-dataclass-fields__scaffold__r1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| mashumaro-flattened-dataclass-fields__scaffold__r2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| mashumaro-flattened-dataclass-fields__verify__r1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| returns-validated-error-accumulation__control__r2 | 0 | 0 | 0 | 0 | 1 | 2 | 821 |
| returns-validated-error-accumulation__distractor__r2 | 0 | 0 | 0 | 0 | 0 | 1 | 237 |
| returns-validated-error-accumulation__guided__r1 | 0 | 0 | 0 | 0 | 1 | 2 | 825 |
| returns-validated-error-accumulation__guided__r2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| returns-validated-error-accumulation__intervene__r1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| returns-validated-error-accumulation__intervene__r2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| returns-validated-error-accumulation__oracle__r1 | 1 | 6 | 6 | 293 | 0 | 0 | 1040 |
| returns-validated-error-accumulation__scaffold__r1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| returns-validated-error-accumulation__scaffold__r2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| returns-validated-error-accumulation__verify__r1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| sqlfmt-create-table-ddl-formatting__control__r2 | 0 | 0 | 0 | 0 | 0 | 0 | 4 |
| sqlfmt-create-table-ddl-formatting__distractor__r2 | 0 | 0 | 0 | 0 | 1 | 1 | 352 |
| sqlfmt-create-table-ddl-formatting__guided__r1 | 0 | 0 | 0 | 0 | 0 | 0 | 4 |
| sqlfmt-create-table-ddl-formatting__guided__r2 | 0 | 0 | 0 | 0 | 0 | 0 | 4 |
| sqlfmt-create-table-ddl-formatting__intervene__r1 | 0 | 0 | 0 | 0 | 0 | 0 | 4 |
| sqlfmt-create-table-ddl-formatting__intervene__r2 | 0 | 0 | 0 | 0 | 0 | 0 | 4 |
| sqlfmt-create-table-ddl-formatting__oracle__r1 | 1 | 1 | 1 | 53 | 0 | 0 | 774 |
| sqlfmt-create-table-ddl-formatting__scaffold__r1 | 0 | 0 | 0 | 0 | 0 | 0 | 4 |
| sqlfmt-create-table-ddl-formatting__scaffold__r2 | 0 | 0 | 0 | 0 | 0 | 0 | 4 |
| sqlfmt-create-table-ddl-formatting__verify__r1 | 0 | 0 | 0 | 0 | 0 | 0 | 4 |

Test authoring: 0/30 runs wrote a test file at all.

| feature | direction | outcome AUC |
| --- | --- | --- |
| test runs | lower = failure | 1.000 |
| best passing tests | lower = failure | 1.000 |
| max edits to one file | higher = failure | 0.574 |
| repeated-command ratio | higher = failure | 0.500 |
| turns since last new file | higher = failure | 0.463 |
| files touched | lower = failure | 0.426 |
| last failing tests | higher = failure | 0.333 |
| tool error rate | higher = failure | 0.049 |

![evidence AUC](plots/evidence-auc.svg)

![patch written vs tests executed](plots/evidence-patch-vs-tests.svg)

Per-run features are in `evidence-features.json`.
