/**
 * Scenario 4 — Genesis-hash invariance.
 *
 * Goal: prove that adding a `forks` field to genesis.json does NOT
 * change the genesis block hash. If this fails, the entire fork model
 * is wrong, so REHEARSAL_PLAN.md insists this runs first.
 *
 * Phases:
 *  1. Bring up node-1 alone on `genesis-pre-fork.json` with
 *     DEMOS_DISABLE_FORK_MACHINERY=true (acts as the pre-fork binary).
 *     Capture the genesis hash and current tip.
 *  2. Stop node-1 (do NOT wipe node1_db).
 *  3. Stage `genesis-fork-low.json` (adds `forks` field, no other
 *     changes). Drop the disable flag. Restart node-1 against the SAME
 *     node1_db.
 *  4. Assert the genesis hash matches phase 1 and the chain continues
 *     past the prior tip without replay-from-zero.
 *
 * Failure mode caught: BlockContent silently includes `forks` (or some
 * other added field) in its hash, which would break every existing
 * node's chain on activation.
 */

import {
    GENESIS_FORK_LOW,
    GENESIS_PRE_FORK,
    compose,
    regenerateIdentities,
    sleep,
    stageGenesis,
    stopService,
    waitFor,
} from "../lib/devnetControl"
import {
    clearOverride,
    composeWithOverride,
    envOverrideYaml,
    writeOverride,
} from "../lib/composeOverrides"
import {
    getGenesisHashFromDb,
    getLastBlockNumber,
} from "../lib/nodeQueries"
import { assert } from "../lib/assertions"
import { runScenarioCli, type ScenarioContext } from "../lib/scenario"

const SCENARIO_ID = "scenario-04"

async function scenario(ctx: ScenarioContext): Promise<void> {
    regenerateIdentities(4)

    // Phase 1: pre-fork genesis, fork machinery disabled on node-1.
    stageGenesis(GENESIS_PRE_FORK)
    writeOverride(
        SCENARIO_ID,
        envOverrideYaml({ "node-1": { DEMOS_DISABLE_FORK_MACHINERY: "true" } }),
    )

    try {
        // Bring up just postgres + tlsnotary + node-1 first, with build.
        composeWithOverride(SCENARIO_ID, [
            "up",
            "-d",
            "--build",
            "postgres",
            "tlsnotary",
            "node-1",
        ])

        await waitFor(
            async () => {
                const h = await getLastBlockNumber(1).catch(() => -1)
                return h >= 1 ? h : null
            },
            {
                description: "node-1 reports head height >= 1 with pre-fork genesis",
                timeoutMs: 120_000,
            },
        )
        // Let it run a bit so we have a non-trivial tip to compare to.
        await sleep(15_000)

        const preGenesisHash = await getGenesisHashFromDb(1)
        const preTip = await getLastBlockNumber(1)
        assert(preGenesisHash, "node-1 has no genesis hash before swap")
        ctx.notes.push(`pre-swap genesis hash: ${preGenesisHash}`)
        ctx.notes.push(`pre-swap tip height: ${preTip}`)

        // Phase 2: stop node-1 — DO NOT wipe DB.
        stopService("node-1")

        // Phase 3: swap genesis to fork-low, drop the disable flag, restart.
        stageGenesis(GENESIS_FORK_LOW)
        writeOverride(
            SCENARIO_ID,
            envOverrideYaml({
                "node-1": { DEMOS_DISABLE_FORK_MACHINERY: "" },
            }),
        )
        // Build picks up the new baked genesis.
        composeWithOverride(SCENARIO_ID, [
            "up",
            "-d",
            "--build",
            "node-1",
        ])

        await waitFor(
            async () => {
                const h = await getLastBlockNumber(1).catch(() => -1)
                return h >= preTip ? h : null
            },
            {
                description: "node-1 reaches its prior tip after genesis swap",
                timeoutMs: 120_000,
            },
        )

        const postGenesisHash = await getGenesisHashFromDb(1)
        ctx.notes.push(`post-swap genesis hash: ${postGenesisHash}`)
        assert(
            postGenesisHash === preGenesisHash,
            "genesis hash changed after adding forks field: " +
                `pre=${preGenesisHash} post=${postGenesisHash}`,
        )

        await sleep(15_000)
        const postPostTip = await getLastBlockNumber(1)
        assert(
            postPostTip >= preTip,
            `node-1 head regressed: pre=${preTip} post=${postPostTip}`,
        )
        ctx.notes.push(`final tip: ${postPostTip} (expected >= ${preTip})`)
    } finally {
        clearOverride(SCENARIO_ID)
        // Touch `compose` to silence the unused import in some builds.
        void compose
    }
}

await runScenarioCli("04-genesis-hash-invariance", scenario)
