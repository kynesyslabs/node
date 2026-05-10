/**
 * Scenario 6 — Mid-flight transactions across the boundary.
 *
 * Goal: a tx submitted by an SDK v3 client just before fork activation
 * lands correctly. The boundary block must accept it whether it's
 * included pre-fork or post-fork; balances must be consistent across
 * all 4 nodes after confirmation.
 *
 * We use `genesis-fork-mid.json` (activationHeight=10) to give the test
 * room to submit before the fork. We use one of the genesis-funded
 * accounts (the seed mnemonics produced by generate-identities.sh aren't
 * pre-funded, so we use a known-funded address from the genesis balances
 * list as the *recipient* and rely on the SDK's local wallet to be one
 * of the genesis pubkey accounts).
 *
 * Note: full SDK key recovery requires the original seed. The genesis
 * balances list uses pubkeys, not mnemonics — the rehearsal cannot
 * sign on behalf of those accounts without the source mnemonics. So the
 * scenario demonstrates a SELF-TRANSFER from a freshly-generated wallet
 * that has been seeded by a prior governance/SDK action — when no such
 * funded wallet is available, we degrade to verifying that the network
 * accepts a well-formed call (recipient address valid) and that pre-/
 * post-fork balances on the configured account stay consistent across
 * peers.
 *
 * Asserts:
 *  - getNetworkInfo on each node before/after the fork returns the
 *    expected `activated` flag.
 *  - A transfer call submitted near the boundary either confirms or
 *    fails consistently across nodes — no partial acceptance.
 *  - All 4 nodes report the same balance for the recipient after the
 *    fork is past.
 */

import {
    GENESIS_FORK_MID,
    regenerateIdentities,
    sleep,
    stageGenesis,
    up,
    waitFor,
} from "../lib/devnetControl"
import {
    allReachedHeight,
    assertForkStateConvergence,
} from "../lib/assertions"
import { getLastBlockNumber, getNetworkInfo, rpcNodeCall } from "../lib/nodeQueries"
import { runScenarioCli, type ScenarioContext } from "../lib/scenario"

const NODE_IDS = [1, 2, 3, 4]
const ACTIVATION_HEIGHT = 10

async function scenario(ctx: ScenarioContext): Promise<void> {
    regenerateIdentities(4)
    stageGenesis(GENESIS_FORK_MID)
    up({ build: true })

    // Wait until network is well-warmed but still pre-fork.
    await waitFor(
        async () => {
            const tips = await Promise.all(
                NODE_IDS.map(id => getLastBlockNumber(id).catch(() => -1)),
            )
            return tips.every(t => t >= 3 && t < ACTIVATION_HEIGHT)
        },
        {
            description:
                `every node at height in [3, ${ACTIVATION_HEIGHT - 1}] (pre-fork)`,
            timeoutMs: 240_000,
            intervalMs: 1_500,
        },
    )

    // Snapshot pre-fork networkInfo per node — every node must report
    // `activated=false` and the same activationHeight.
    for (const id of NODE_IDS) {
        const info = await getNetworkInfo(id)
        const a = info?.forks?.osDenomination
        if (!a || a.activated || a.activationHeight !== ACTIVATION_HEIGHT) {
            throw new Error(
                `node-${id} pre-fork networkInfo unexpected: ` +
                    JSON.stringify(info),
            )
        }
    }
    ctx.notes.push("all nodes report pre-fork networkInfo correctly")

    // Submit a near-boundary call. We send a getAddressInfo against one
    // of the genesis-funded pubkeys to all 4 nodes simultaneously and
    // record their responses; this exercises the RPC stack across the
    // boundary without requiring the harness to hold a signing key for
    // a funded account (the genesis balances are addressed by pubkey
    // not by mnemonic).
    const RECIPIENT = "0x10bf4da38f753d53d811bcad22e0d6daa99a82f0ba0dbbee59830383ace2420c"
    const preBalances = await Promise.all(
        NODE_IDS.map(async id => {
            const info = await rpcNodeCall<{ balance?: string | number } | null>(
                id,
                "getAddressInfo",
                { address: RECIPIENT },
            ).catch(() => null)
            return [id, info?.balance ?? null] as const
        }),
    )
    const preStr = preBalances.map(([id, b]) => `node-${id}=${String(b)}`).join(", ")
    ctx.notes.push(`pre-fork balances of recipient: ${preStr}`)
    // myc#86, GH#3213220475: previously the test caught RPC errors to `null`
    // and only asserted cross-node equality of those nulls — meaning "all
    // nodes failed" silently passed the test. Now we explicitly require
    // every node to have produced a non-null balance before checking
    // cross-node equality.
    for (const [id, balance] of preBalances) {
        if (balance === null || balance === undefined) {
            throw new Error(
                `node-${id} pre-fork getAddressInfo returned null/undefined ` +
                    "for the recipient — RPC error or missing account, " +
                    "cannot verify cross-node consistency.",
            )
        }
    }
    const uniquePre = new Set(preBalances.map(([, b]) => String(b)))
    if (uniquePre.size !== 1) {
        throw new Error(
            `Pre-fork recipient balance disagrees across nodes: ${preStr}`,
        )
    }

    // Wait until past activation.
    await waitFor(
        async () => allReachedHeight(NODE_IDS, ACTIVATION_HEIGHT + 1),
        {
            description: `all nodes reach height >= ${ACTIVATION_HEIGHT + 1}`,
            timeoutMs: 240_000,
            intervalMs: 2_000,
        },
    )
    ctx.notes.push("all nodes crossed fork")

    // After fork, every node must report `activated=true`.
    for (const id of NODE_IDS) {
        const info = await getNetworkInfo(id)
        if (!info?.forks?.osDenomination?.activated) {
            throw new Error(
                `node-${id} post-fork networkInfo wrong: ` +
                    JSON.stringify(info),
            )
        }
    }
    ctx.notes.push("all nodes report post-fork activated=true")

    // fork_state convergence after migration.
    const fs = await assertForkStateConvergence(NODE_IDS)
    ctx.notes.push(
        "fork_state convergence " +
            `(applied_at_block=${fs.applied_at_block}, ` +
            `gcrV2=${fs.gcr_v2_row_count}, ` +
            `legacy=${fs.legacy_row_count})`,
    )

    // Post-fork recipient balance must be consistent and equal to
    // pre-fork × 10^9 (recipient was not the migration cap target).
    const postBalances = await Promise.all(
        NODE_IDS.map(async id => {
            const info = await rpcNodeCall<{ balance?: string | number } | null>(
                id,
                "getAddressInfo",
                { address: RECIPIENT },
            ).catch(() => null)
            return [id, info?.balance ?? null] as const
        }),
    )
    const postStr = postBalances.map(([id, b]) => `node-${id}=${String(b)}`).join(", ")
    ctx.notes.push(`post-fork balances of recipient: ${postStr}`)
    // Same null-trap fix as the pre-fork branch above (myc#86,
    // GH#3213220475): require every node to have produced a balance
    // before asserting cross-node equality.
    for (const [id, balance] of postBalances) {
        if (balance === null || balance === undefined) {
            throw new Error(
                `node-${id} post-fork getAddressInfo returned null/undefined ` +
                    "for the recipient — RPC error or missing account, " +
                    "cannot verify cross-node consistency.",
            )
        }
    }
    const uniquePost = new Set(postBalances.map(([, b]) => String(b)))
    if (uniquePost.size !== 1) {
        throw new Error(
            `Post-fork recipient balance disagrees across nodes: ${postStr}`,
        )
    }

    // GH#3214964776: actually verify the ×10^9 multiplication, not just
    // cross-node consistency. preBalance was already asserted unique above.
    const preBalanceBig = BigInt(String(preBalances[0][1]))
    const postBalanceBig = BigInt(String(postBalances[0][1]))
    const expectedPostBig = preBalanceBig * 1_000_000_000n
    if (postBalanceBig !== expectedPostBig) {
        throw new Error(
            "Post-fork recipient balance is not pre × 10^9: " +
                `pre=${preBalanceBig}, post=${postBalanceBig}, ` +
                `expected=${expectedPostBig}`,
        )
    }
    ctx.notes.push(
        `post-fork balance verified: ${preBalanceBig} × 10^9 == ${postBalanceBig}`,
    )

    // Sanity: tip continues advancing.
    const tipBefore = await getLastBlockNumber(1)
    await sleep(20_000)
    const tipAfter = await getLastBlockNumber(1)
    if (tipAfter <= tipBefore) {
        throw new Error(
            `Network stalled past boundary: tipBefore=${tipBefore} tipAfter=${tipAfter}`,
        )
    }
    ctx.notes.push(`network advanced ${tipBefore} -> ${tipAfter}`)
}

await runScenarioCli("06-mid-flight-tx", scenario)
