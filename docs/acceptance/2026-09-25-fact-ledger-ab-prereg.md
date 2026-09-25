# Fact Ledger A/B Preregistration

**Experiment**: `fact-ledger-injection`
**Date**: 2026-09-25
**Scenario file**: [`scenarios/fact-ledger-ab.json`](scenarios/fact-ledger-ab.json)
**Script**: [`scripts/fact-ledger-ab-eval.cjs`](../../scripts/fact-ledger-ab-eval.cjs)
**Runtime**: compiled `dist/` from current `src/`
**Model**: `deepseek-v4.1-flash`
**Total calls**: 18
**Repeats per arm**: 3
**Retries**: 0

## Goal

Test whether adding an experimental read-only thin fact ledger to the same model improves semantic continuity on hard cases. This experiment tests only whether injecting authoritative facts helps the current model. It does not test whether the ledger can be automatically maintained, repaired, or populated in production.

## Arms

- **A (`baseline`)**: current full turn prompt, unchanged.
- **B (`ledger`)**: same full turn prompt plus a read-only authoritative thin fact ledger.

Both arms use the same model, the same fixture, the same `playerInput`, and the same runtime. The only intended difference is the injected ledger section.

## Cases

1. **private-info**: private information must not leak to a character who does not know it.
2. **open-decision**: a major player decision remains open until the player decides.
3. **causal-continuity**: time, causality, and physical constraints remain coherent without invented causes.

## Execution order

Each case runs 3 times per arm. The three rounds use:

1. `baseline`, `ledger`
2. `ledger`, `baseline`
3. `baseline`, `ledger`

Every case creates a new story. `WORKSPACE_ROOT` is isolated inside the output directory. `PI_MAX_ATTEMPTS=1`.

## Success criteria

B is considered successful only if:

- All 18 calls complete with exactly one model call each.
- No case has an obvious privacy leak, player-choice violation, or causal discontinuity.
- B is preferred over A in at least 2 of the 3 paired blind reviews for at least 2 of the 3 cases.
- B's aggregate error count across the 3 cases is lower than A's.
- B does not regress technical pass rate.

## Blind review

Each blind file contains only the player-facing prose, with no arm label. Reviewers see:

- the scenario title and current player input,
- the prior history,
- the case-specific blind checklist,
- two blind texts in randomized order.

Reviewers first mark any hard privacy, agency, or causality violation. Then they choose which text is preferred, or mark a tie if both are equally correct and natural. They may consult the mapping file only after all blind reviews are complete.

## Stop rules

Stop immediately if:

- any run makes more than one model call,
- any prompt missing the ledger in B,
- any B prompt changes the baseline workspace context,
- any run leaks `.env`, keys, headers, or thinking content,
- any workspace snapshot or result file is missing,
- any run fails technically and retry is required,
- any story is reused across cases,
- the total call count would exceed 18.

Do not rerun failed cases. Record the failure and stop.

## Limit

This experiment tests injection benefit only. It does not prove that automatic ledger extraction, maintenance, or repair is feasible, and it does not propose enabling the ledger by default.
