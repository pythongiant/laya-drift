# Literature review: making the semantic drift monitor useful

Scope: keep Laya's concepts (typed questions, calibrated probability
distributions, single forward pass) and build a **detection-only** monitor on
top. No intervention work. The monitor must say "the session left the plan"
with controlled false alarms, not "run this fix".

## Laya (the base we build on)

- Laya model card / docs, `convaiinnovations/laya` (HF) — non-autoregressive
  System 1 decision model. `choice`/`score`/`noul` typed questions return
  calibrated probabilities and a confidence per answer in one forward pass;
  trained with RLCD against strictly proper scoring rules (log + spherical +
  ranked probability score for ordinal), with per-question-type temperature
  calibration. Reported ECE 0.081 vs 0.246 for the previous model.
- Consequences for this work: confidence is meaningful and can be used as a
  weight/gate; questions can be batched, so paraphrase ensembles are cheap;
  answers are distributions, so divergence-based statistics are the natural
  currency.

## Drift detection in streams (what to monitor)

- **Page (1954), CUSUM; Bifet & Gavaldà (2007), ADWIN.** Classic sequential
  change detection: accumulate evidence of a mean shift instead of thresholding
  single observations. ADWIN compares a reference window with a recent window
  under a Hoeffding bound and needs no cutoff parameter.
- **Hinder et al. (2024), "One or two things we know about concept drift",
  Frontiers in AI, Parts A/B.** Survey of unsupervised drift detection:
  taxonomy of window-based (fixed/sliding/adaptive), statistical-test and
  density-based detectors; part B covers localization/explanations. Key
  practical lesson: compare distributions across *windows*, not pointwise, and
  expect a sensitivity/specificity trade-off that must be calibrated.
- **Xie et al. (2022), arXiv:2210.05181.** Tutorial on sequential change-point
  detection; formalizes average run length (ARL) and expected detection delay
  (EDD), the exact metrics a monitor should report.

## Anytime-valid alarms (how to control false alarms)

- **Ramdas et al., arXiv:2210.01948, "Game-Theoretic Statistics and Safe
  Anytime-Valid Inference".** E-processes (nonnegative supermartingales) give
  evidence valid at *any* stopping time; reject the null when the process
  reaches `1/α`. This is the right guarantee for a monitor that is watched
  continuously.
- **arXiv:2602.12983, "Detecting Object Tracking Failure via Sequential
  Hypothesis Testing".** The closest template: an e-process over a per-step
  failure signal, `X_t = Π (1 + λ_i (ε − M_i))` with a predictable betting rate
  `λ_t`, rejecting `H0` when `X_t ≥ 1/α`. Model-agnostic, no training,
  lightweight, with provably bounded false alerts and low detection delay.
  Adopted here almost verbatim, with `M_t` = per-turn divergence and `ε` a
  tolerance level.

## Better signals from the same model (how to improve specificity)

- **Wang et al., arXiv:2203.11171 (self-consistency).** Sampling/paraphrasing
  the same question and aggregating improves reliability over a single sample.
  Cheap for Laya because all paraphrases fit in one forward pass.
- **Kuhn et al., arXiv:2302.09664 (semantic entropy); Kossen et al.,
  arXiv:2405.20003 (kernel language entropy).** Uncertainty should be measured
  over *meanings*, not surface forms; marginalizing over semantically
  equivalent variants is more predictive of correctness than raw entropy.
  Translated here to: average divergence across paraphrase variants of the same
  construct, weighted by Laya confidence.
- **arXiv:2603.21172, "Entropy Alone is Insufficient for Safe Selective
  Prediction in LLMs".** Entropy-style signals fail in the "confidently wrong"
  regime; combining them with a second signal (a correctness probe) improves
  the risk–coverage trade-off. Translates to: gate alarms on Laya confidence,
  and report risk–coverage rather than AUROC alone.
- **arXiv:2604.07172; Guo et al., arXiv:1706.04599.** Temperature scaling of
  semantic confidence improves calibration and discrimination; a single global
  scalar is a strong regularizer. Laya already ships fitted temperatures, so we
  calibrate the *aggregate monitor statistic* (isotonic/threshold calibration)
  rather than the model.

## Calibrated thresholds (what an alarm means)

- **arXiv:2607.04430 (CIC).** Treat any uncertainty score as a black-box
  ranking signal; on a held-out calibration set pick the largest threshold whose
  upper confidence bound on the accepted-error rate stays under a target risk
  `α`. Directly applicable: choose the alarm threshold so that observed
  false-alarm rate on null runs is bounded.
- **arXiv:2608.12008 (A-CRC-QA).** Post-hoc, model-agnostic risk calibration
  for selective question answering; asymptotic risk control without retraining.

## What this work adopts

1. **Paraphrase-ensemble probes** (self-consistency / semantic entropy):
   3 wordings of `alignment` + 2 of `plan_ref`, batched in one Laya pass,
   aggregated by confidence-weighted mean JS divergence.
2. **Reference-window baseline** (ADWIN/ShapeDD-style window comparison):
   divergence is measured against the calibration window (first substantive
   turns), taking the *minimum* over the window to avoid single-anchor noise.
3. **Confidence gating** (selective prediction): turns whose mean Laya
   confidence is low are reported as "no call" instead of scoring them.
4. **E-process alarm** (SAVI / object-tracking recipe): per-turn divergence is
   turned into a test supermartingale; alarm when it crosses `1/α`, which
   bounds the false-alarm probability at any stopping time.
5. **Calibrated alarm threshold** (CIC-style): the tolerance `ε` and gate are
   chosen on held-out null runs so the empirical false-alarm rate is bounded,
   and reported as such.
6. **Evaluation metrics** the literature asks for: TPR at fixed FPR, detection
   delay (EDD) and average run length (ARL) on null runs, plus risk–coverage
   instead of a single AUROC.

## What this work deliberately does not do

- No intervention, no prompting of the agent, no policy changes (see the
  intervention results in the main README).
- No fine-tuning of Laya: everything is post-hoc on its calibrated outputs.
- No claim of formal validity on this sample: the e-process construction is
  cited, but the null calibration uses 24 logged non-drifted runs, which is a
  pilot, not a guarantee.
