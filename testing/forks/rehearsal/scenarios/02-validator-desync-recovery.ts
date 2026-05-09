/**
 * Scenario 2 — Validator desync recovery.
 *
 * Goal: an out-of-date validator can catch up by wiping its DB and
 * re-syncing from genesis after the fork has already happened.
 *
 * Setup:
 *  - Nodes 1-3 run with the fork machinery enabled (default).
 *  - Node 4 starts with DEMOS_DISABLE_FORK_MACHINERY=true → it behaves
 *    as a pre-fork binary: it never loads the genesis `forks` field
 *    and never runs the migration hook.
 *  - All four use `genesis-fork-low.json` (activationHeight = 5).
 *
 * Action:
 *  1. `docker compose up -d`.
 *  2. Wait until nodes 1-3 cross height 5 and migrate. Node 4 stays
 *     stuck (post-fork blocks fail validation under its pre-fork
 *     understanding) — verify it logs explicitly loud errors.
 *  3. `docker compose stop node-4`. Drop node4_db. Remove the disable
 *     flag. Restart node-4 (rebuilds with default image).
 *  4. Wait for node-4 to catch up to peers.
 *
 * Asserts:
 *  - Phase A: node-4 is desynced and logs a loud error string.
 *  - Phase B: after wipe + restart, node-4 catches up; fork_state and
 *    block hashes match nodes 1-3.
 */

import {
    GENESIS_FORK_LOW,
    logs,
    regenerateIdentities,
    sleep,
    stageGenesis,
    waitFor,
} from "../lib/devnetControl"
import {
    clearOverride,
    composeWithOverride,
    envOverrideYaml,
    writeOverride,
} from "../lib/composeOverrides"
import {
    assertBlockHashConvergence,
    assertForkStateConvergence,
    allReachedHeight,
} from "../lib/assertions"
import {
    dropAndRecreateNodeDb,
    getLastBlockNumber,
} from "../lib/nodeQueries"
import { assert } from "../lib/assertions"
import { runScenarioCli, type ScenarioContext } from "../lib/scenario"

const SCENARIO_ID = "scenario-02"
const HEALTHY_NODES = [1, 2, 3]
const ALL_NODES = [1, 2, 3, 4]
const ACTIVATION_HEIGHT = 5
const LOUD_ERROR_REGEX = /(hash\s*mismatch|invalid\s*block|signature|fork|migration|reject)/i

async function scenario(ctx: ScenarioContext): Promise<void> {
    regenerateIdentities(4)
    stageGenesis(GENESIS_FORK_LOW)

    try {
        // Phase A: bring up all 4, with the disable flag on node-4.
        writeOverride(
            SCENARIO_ID,
            envOverrideYaml({
                "node-4": { DEMOS_DISABLE_FORK_MACHINERY: "true" },
            }),
        )
        composeWithOverride(SCENARIO_ID, ["up", "-d", "--build"])

        // Wait for nodes 1-3 to cross the fork.
        await waitFor(
            async () => allReachedHeight(HEALTHY_NODES, ACTIVATION_HEIGHT + 1),
            {
                description: `nodes 1-3 reach height >= ${ACTIVATION_HEIGHT + 1}`,
                timeoutMs: 240_000,
                intervalMs: 2_000,
            },
        )
        ctx.notes.push("nodes 1-3 crossed fork")

        // Verify node-4 is stuck at < activation height.
        // Give it 30 seconds to attempt sync and fail.
        await sleep(30_000)
        const node4Tip = await getLastBlockNumber(4).catch(() => -1)
        ctx.notes.push(`node-4 tip after 30s post-fork: ${node4Tip}`)

        // Loud-error check: node-4's log should contain something explicit.
        const node4Logs = logs("node-4", 800)
        if (!LOUD_ERROR_REGEX.test(node4Logs)) {
            throw new Error(
                "Expected node-4 to log a loud error (hash/sig/fork/migration); " +
                    "found nothing matching. Sample:\n" +
                    node4Logs.slice(-2_000),
            )
        }
        ctx.notes.push("node-4 logged a loud failure as expected (Phase A)")

        // Phase B: stop node-4, wipe DB, drop the flag, restart.
        composeWithOverride(SCENARIO_ID, ["stop", "node-4"])
        await dropAndRecreateNodeDb(4)
        writeOverride(
            SCENARIO_ID,
            envOverrideYaml({ "node-4": { DEMOS_DISABLE_FORK_MACHINERY: "" } }),
        )
        composeWithOverride(SCENARIO_ID, ["up", "-d", "--build", "node-4"])

        // Wait for node-4 to catch up to the rest of the network.
        await waitFor(
            async () => {
                const tips = await Promise.all(
                    ALL_NODES.map(async id => [id, await getLastBlockNumber(id).catch(() => -1)] as const),
                )
                const peerTip = Math.min(...tips.filter(([id]) => id !== 4).map(([, t]) => t))
                const node4 = tips.find(([id]) => id === 4)?.[1] ?? -1
                return node4 >= peerTip - 2 && node4 >= ACTIVATION_HEIGHT + 1
            },
            {
                description: "node-4 catches up to peer tip after wipe",
                timeoutMs: 300_000,
                intervalMs: 3_000,
            },
        )
        ctx.notes.push("node-4 caught up after wipe")

        // Convergence: fork_state and block hashes match.
        const fs = await assertForkStateConvergence(ALL_NODES)
        ctx.notes.push(
            "fork_state on all 4 nodes converged " +
                `(applied_at_block=${fs.applied_at_block}, capped=${fs.capped_count})`,
        )
        const h = await assertBlockHashConvergence(ALL_NODES, ACTIVATION_HEIGHT)
        ctx.notes.push(`block ${ACTIVATION_HEIGHT} hash converged: ${h}`)

        assert(true, "Phase B converged")
    } finally {
        // myc#86, GH#3213220471: previously `clearOverride` was only called
        // on the happy path. On any failure the compose env override leaked
        // into subsequent scenarios. Always clear in `finally`.
        clearOverride(SCENARIO_ID)
    }
}

await runScenarioCli("02-validator-desync-recovery", scenario)
