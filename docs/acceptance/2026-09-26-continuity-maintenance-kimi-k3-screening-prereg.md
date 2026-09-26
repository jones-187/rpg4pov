# Continuity Card maintenance: Kimi K3 screening preregistration

This is a bounded first-stage capability screen following Round 2. It reuses the exact three frozen cases from [`scenarios/continuity-maintenance-ab.json`](scenarios/continuity-maintenance-ab.json), pinned by SHA-256 in [`scenarios/continuity-maintenance-kimi-k3-screening.json`](scenarios/continuity-maintenance-kimi-k3-screening.json).

## Fixed design

- Model: `kimi-k3`, read from the screening scenario and required to equal the temporary runtime's `resolveAgentModel()` result.
- Pi thinking: `xhigh` (the configured highest supported setting).
- Arm: maintained only; initial Continuity Card is loaded and the public card maintenance path is active.
- Samples: 3 cases × 3 repeats = 9 independent workspaces and 9 planned model calls.
- One turn and exactly one model call per sample. `PI_MAX_ATTEMPTS=1`; no retries and no replacement samples.
- Each run saves the initial card, card before and after the turn, turn record, committed history, response when available, and a result summary. The manifest records planned and completed calls and technical passes.
- The screening runner refuses to start if the frozen source scenario hash differs or if the temporary runtime resolves a different model.

The production `src/lib/agent-model.ts` default remains unchanged. Prepare a disposable compiled runtime whose `lib/agent-model.js` resolves to `kimi-k3`, set its matching `ANTHROPIC_MODEL` value if that runtime enforces the environment setting, and pass that runtime with `--runtime`. The runner verifies the resolved model and the actual Pi invocation model on every sample. Do not patch the production source to perform this screen.

## Decision gate

Advance to the full 36-call A/B only if all 9 runs are technically successful and a semantic audit of all 9 maintained card updates finds zero hard semantic errors. A hard error includes invented or unsupported facts, wrong source or witness attribution, private-knowledge leakage, resolving or retiring an unresolved fact without evidence, or recording a player decision the player did not make.

If either gate fails, stop this model screen. Do not rerun failed samples, add repair agents, add model retries, or add semantic fallback rules. Record the result and decide whether a different model is warranted before spending on a full A/B.

## Invocation

Build the project into a disposable runtime, make only that runtime's model policy resolve `kimi-k3`, then run:

```sh
node scripts/continuity-maintenance-screening.cjs \
  --scenario docs/acceptance/scenarios/continuity-maintenance-kimi-k3-screening.json \
  --output data/evaluations/continuity-maintenance-kimi-k3-screening-<run-id> \
  --runtime <disposable-compiled-runtime>
```

The output directory must be new and empty. The screening runner writes evaluation evidence there; it does not modify production model configuration.
