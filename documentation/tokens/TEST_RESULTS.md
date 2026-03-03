# Token test runs (better_testing) — results

This file summarizes **token-related** test runs executed via `better_testing/` and the observed result status.

Scope:
- Runs are from the multi-node **devnet** harness (4 nodes + postgres).
- Each RUN_ID has artifacts under `better_testing/runs/<RUN_ID>/` (typically `*.summary.json` and sometimes `*.timeseries.jsonl`).
- “Committed” read endpoints (`*Committed`) may transiently return `409 STATE_IN_FLUX` during sync/consensus apply; scenarios treat those as retryable unless stated otherwise.

If you add new runs, append them here **and** keep `better_testing/README.md` updated.

---

## Verified runs (PASS)

### token_observe under load (committed read probe)

These runs produced `token_observe.timeseries.jsonl` and passed local analysis (no divergence on non-null hashes; tail convergence).

- `token-observe-under-load-plain-20260302-130537` — PASS
- `token-observe-under-load-scripted-20260302-132018` — PASS

### Complex/branchy token scripts (“complex policy” suite)

These runs validate deterministic script behavior across nodes (cross-node state convergence and deterministic rejects where applicable):

- `token_script_complex_policy_smoke-20260303-130602` — PASS  
  Exercises allowlist/denylist/quota/fees branches, plus invariants like `totalSupply == sum(balances)` and script storage convergence.
- `token_script_complex_policy_smoke-20260303-132251` — PASS
- `token_script_complex_policy_smoke-20260303-150133` — PASS

- `token_script_complex_policy_ramp-20260303-130724` — PASS  
  Ramps transfers while complex policy is configured to avoid rejects (useful to catch convergence/perf regressions).

- `token_script_complex_policy_dynamic_updates-20260303-134836` — PASS  
  In-band admin updates (owner “command” self-transfers) updating `customState.policyOverride`; validates deterministic reject/accept outcomes and state convergence.

- `token_script_complex_policy_vesting_lockup-20260303-151227` — PASS  
  Vesting/lockup gates implemented via **admin-controlled releases** (no time/height-based vesting in the current hook ctx); validates deterministic `vesting_locked` rejects and convergence.

- `token_script_complex_policy_escrow_state_machine-20260303-153800` — PASS  
  Escrow-like state machine in `customState` (deposit → pending → approve release/refund → claimed/refunded); validates deterministic `escrow_no_entry` rejects and convergence.

### Scripted mint/burn ramps (hooks on every op)

- `token_script_mint_ramp-20260303-112435` — PASS
- `token_script_burn-20260303-123048` — PASS
- `token_script_burn_ramp-20260303-123438` — PASS

---

## Notes / caveats

- This file only lists runs that have a concrete, recorded RUN_ID in `better_testing/README.md` (i.e. something we can point to and reproduce/inspect).
- Additional token scenarios exist in `better_testing/loadgen/src/`, but should only be marked “Verified” here once a RUN_ID is recorded and artifacts are present.

