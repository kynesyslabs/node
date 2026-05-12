/**
 * Scenario 10 — DEM-665 burn-address spend rejection.
 *
 * STATUS: Placeholder. The devnet-level integration this scenario
 * would ideally drive — submit a signed tx with a manual
 * `remove`-from-burn GCREdit and assert the validating node rejects
 * it with "Cannot deduct from burn address" — requires a signing
 * helper for genesis-funded accounts that the rehearsal harness does
 * not yet provide.
 *
 * What we cannot do here (yet):
 *
 *   - The harness's `rpcNodeCall` helper is unsigned. Submitting a
 *     fee-bearing native transfer needs a private key for one of the
 *     genesis-funded accounts. Existing scenarios (01..08) carefully
 *     avoid this by exercising read-only RPC + Postgres state.
 *
 *   - Inserting a `remove`-from-burn row directly into `gcr_main` via
 *     psql does NOT exercise the guard — `GCRBalanceRoutines.apply`
 *     is called by the block-apply path, not the SQL layer. A raw
 *     INSERT/UPDATE bypasses every consensus check by design.
 *
 *   - Constructing a signed tx in-process would require pulling
 *     @kynesyslabs/demosdk's signing utilities into the harness and
 *     wiring `regenerateIdentities()` to produce a funded keypair —
 *     a non-trivial addition that mirrors the same gap noted in
 *     scenario 06.
 *
 * Coverage of the burn-spend rejection lives at UNIT LEVEL in:
 *
 *   - tests/blockchain/GCRBalanceRoutines.test.ts (8 cases):
 *       • normal remove against burn rejected when fork active
 *       • rollback inversion against burn allowed
 *       • normal remove against burn allowed pre-fork
 *       • remove against non-burn account allowed
 *       • add to burn allowed (fee-distribution path)
 *       • uppercase-hex edit account still hits the guard (case norm)
 *       • null feeDistribution falls through (defensive)
 *       • lastBlockNumber < activationHeight falls through (gate)
 *
 *   - tests/blockchain/feeDistribution.test.ts (16 cases) covers the
 *     edits *that produce* the burn `add` rows, so the apply layer's
 *     guard against undoing them is exercised by the rollback case.
 *
 * This file is kept in-tree so future work that adds tx-signing
 * support to the harness has a named home and the deferral is
 * discoverable from `scenarios/`. When the harness gains a signing
 * helper, the scenario body should:
 *
 *   1. Bring up the 4-node devnet with genesis-fork-low-gasFee.json.
 *   2. Wait for fork crossing (height >= 6).
 *   3. Build a `transferNative` tx with `gcr_edits = [{ type:"balance",
 *      operation:"remove", account: BURN_ADDRESS, amount: 1n }]`.
 *   4. Sign with a genesis-funded key.
 *   5. Submit to node-1; assert HTTP/error response contains "Cannot
 *      deduct from burn address".
 *   6. Replay via fresh-node sync; assert the rejected tx is absent
 *      from every peer's `transactions` table.
 */

import { runScenarioCli, type ScenarioContext } from "../lib/scenario"

async function scenario(ctx: ScenarioContext): Promise<void> {
    void ctx
    process.stdout.write(
        "[SKIP] scenario 10 burn-spend-rejection: harness lacks tx-signing " +
            "support; coverage at unit level in tests/blockchain/" +
            "GCRBalanceRoutines.test.ts (8 cases). See file docstring.\n",
    )
    // Intentional clean exit so run-all.sh treats this scenario as a
    // documented no-op rather than a failure.
}

await runScenarioCli("10-burn-spend-rejection", scenario)
