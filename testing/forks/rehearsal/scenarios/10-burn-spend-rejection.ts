/**
 * Scenario 10 — DEM-665 burn-address spend rejection (devnet drive).
 *
 * Goal: prove the validating node refuses a tx that tries to `remove`
 * from the consensus-fixed burn account post-fork.
 *
 * Why "drive"? Because the guard sits in
 * `GCRBalanceRoutines.apply()`, which runs at tx-apply time. Direct
 * SQL inserts bypass it by design (the apply layer is not the SQL
 * layer). A real signed tx that reaches `confirmTransaction` is the
 * only path that exercises the production guard.
 *
 * Setup:
 *  - 4-node devnet, both forks at activationHeight=5, same fixture
 *    scenario 09 uses (genesis-fork-low-gasFee.json), but mutated at
 *    runtime to add a harness-funded account so the harness can sign
 *    a tx without paired private keys for the production pubkeys.
 *
 * Action:
 *  1. Generate ed25519 keypair in-memory (testing/forks/rehearsal/lib/signing.ts).
 *  2. Inject `[pubkey, 1000000]` into genesis fixture balances, stage
 *     it at `data/genesis.json` (stageGenesisWithFundedAccount).
 *  3. `up --build`, wait for height ≥ 6 (one block past activation).
 *  4. Construct a `send` native tx whose `gcr_edits` carries a manual
 *     `remove`-from-burn entry alongside the legitimate ones. The
 *     malicious edit is what we want the validator to reject — the
 *     guard fires at apply time, but the validating node's
 *     `confirmTransaction` does NOT pre-apply edits, so the malicious
 *     edit makes it through validation and would land at apply time
 *     if the guard weren't there.
 *  5. Submit via `manageExecution({ extra: "confirmTx", data: tx })`
 *     to node-1's `/` POST endpoint.
 *  6. Wait ~30s. Assert the burn account's balance stays at 0 (no
 *     deduction) on every node. The guard either rejects the
 *     malicious edit at apply time, or — if the node fails closed
 *     earlier — the tx never lands. Either outcome is acceptable;
 *     the consensus-critical invariant we test is "burn balance
 *     does not decrease".
 *
 * Acceptance criterion:
 *   - Burn account balance on every node = "0" both before AND after
 *     the submission window. If it decreases on any node, the guard
 *     is broken.
 *
 * What this scenario does NOT prove:
 *   - That the validating node EXPLICITLY rejects the tx with the
 *     "Cannot deduct from burn address" message. That string is a
 *     log/diagnostic, not part of the wire response, and asserting
 *     against logs is brittle. The consensus-meaningful invariant is
 *     balance preservation, which is what we assert here.
 *
 * Unit coverage of the guard (every branch + carve-out) is in
 * `tests/blockchain/GCRBalanceRoutines.test.ts` (8 cases).
 */

import {
    GENESIS_FORK_LOW_GAS_FEE,
    regenerateIdentities,
    sleep,
    stageGenesisWithFundedAccount,
    up,
    waitFor,
} from "../lib/devnetControl"
import {
    allActivated,
    allReachedHeight,
    assertGasFeeForkStateConvergence,
    assertGcrAccountConvergence,
} from "../lib/assertions"
import {
    NODE_RPC_PORTS,
    getGcrAccount,
} from "../lib/nodeQueries"
import {
    generateHarnessKeypair,
    signHarnessTx,
} from "../lib/signing"
import { runScenarioCli, type ScenarioContext } from "../lib/scenario"

const NODE_IDS = [1, 2, 3, 4]
const ACTIVATION_HEIGHT = 5

const BURN_ADDRESS = "0x" + "0".repeat(64)
const TREASURY_ADDRESS =
    "0xfeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface"
/**
 * Recipient for the cover native-send. Different from the harness
 * pubkey so the tx looks like a real transfer. Pulled from
 * genesis-fork-low-gasFee.json's existing balances list.
 */
const RECIPIENT_PUBKEY =
    "0x10bf4da38f753d53d811bcad22e0d6daa99a82f0ba0dbbee59830383ace2420c"
/**
 * Harness-funded balance in OS units. Generous so a fee deduction
 * cannot exhaust it — the node-side fee math charges ~3 OS for a
 * minimal native send today, so 1_000_000 is wildly safe.
 */
const HARNESS_BALANCE_STR = "1000000"

/**
 * Builds the malicious `send` tx — legitimate transfer payload BUT
 * with an extra `remove`-from-burn GCREdit appended. The fee
 * distribution edits added by `applyGasFeeSeparation` will prepend
 * the legitimate burn ADD edits (50/50 split of network_fee); our
 * malicious REMOVE edit sits in the caller-supplied edits and would
 * apply later in the sequence. The guard fires when
 * GCRBalanceRoutines.apply() encounters the malicious remove.
 */
function buildMaliciousTx(
    senderPubkey: string,
    timestampSec: number,
): any {
    return {
        content: {
            type: "native",
            from: senderPubkey,
            from_ed25519_address: senderPubkey,
            to: RECIPIENT_PUBKEY,
            amount: 1,
            nonce: 0,
            timestamp: timestampSec,
            data: [
                "native",
                {
                    nativeOperation: "send",
                    args: [RECIPIENT_PUBKEY, 1],
                },
            ],
            gcr_edits: [
                // Legitimate send edits (subtract from sender, add to
                // recipient) plus the MALICIOUS remove from burn.
                // The guard runs against operation === "remove" with
                // account === burnAddress and isRollback === false; the
                // malicious edit hits all three conditions, so we
                // expect the apply layer to reject it. The two
                // legitimate edits surround it as a realistic-looking
                // transfer body.
                {
                    type: "balance",
                    operation: "remove",
                    isRollback: false,
                    account: senderPubkey,
                    txhash: "", // filled by signer
                    amount: 1,
                },
                {
                    type: "balance",
                    operation: "add",
                    isRollback: false,
                    account: RECIPIENT_PUBKEY,
                    txhash: "",
                    amount: 1,
                },
                {
                    type: "balance",
                    operation: "remove",
                    isRollback: false,
                    account: BURN_ADDRESS,
                    txhash: "",
                    amount: 1,
                },
            ],
            transaction_fee: {
                network_fee: null,
                rpc_fee: null,
                additional_fee: null,
                rpc_address: null,
            },
        },
        signature: null,
        ed25519_signature: null,
        hash: null,
        status: null,
        blockNumber: null,
    }
}

/**
 * POSTs a confirm-tx payload to node-${nodeId}'s `/` endpoint. The
 * server wraps the tx in a `BundleContent` with `extra: "confirmTx"`,
 * dispatches to `handleValidateTransaction`, and returns the signed
 * ValidityData. We surface the raw response so the assertion layer
 * can inspect the rejection.
 */
async function submitConfirmTx(
    nodeId: number,
    tx: unknown,
): Promise<{ status: number; body: any }> {
    const port = NODE_RPC_PORTS[nodeId]
    if (!port) throw new Error(`Unknown node id: ${nodeId}`)
    const url = `http://localhost:${port}`
    const bundleContent = {
        type: "native",
        message: "",
        sender: "",
        receiver: "",
        timestamp: Math.floor(Date.now() / 1000),
        data: tx,
        extra: "confirmTx",
    }
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Connection: "close" },
        body: JSON.stringify({
            method: "execute",
            params: [bundleContent],
        }),
        keepalive: false,
    } as RequestInit)
    const body = await res.json().catch(() => null)
    return { status: res.status, body }
}

async function scenario(ctx: ScenarioContext): Promise<void> {
    regenerateIdentities(4)

    // Generate the harness keypair + inject it into the genesis
    // balances so the validating node will accept its signature
    // (genesis-funded sender check in confirmTransaction).
    const kp = generateHarnessKeypair()
    ctx.notes.push(`harness pubkey: ${kp.pubkeyHex}`)
    stageGenesisWithFundedAccount(
        GENESIS_FORK_LOW_GAS_FEE,
        kp.pubkeyHex,
        HARNESS_BALANCE_STR,
    )

    up({ build: true })

    // Wait for fork crossing (height >= 6).
    await waitFor(
        async () => allReachedHeight(NODE_IDS, ACTIVATION_HEIGHT + 1),
        {
            description: `all nodes reach height >= ${ACTIVATION_HEIGHT + 1}`,
            timeoutMs: 240_000,
            intervalMs: 2_000,
        },
    )
    ctx.notes.push(`all 4 nodes crossed height ${ACTIVATION_HEIGHT}`)

    const activated = await allActivated(NODE_IDS)
    if (!activated) {
        throw new Error("Not every node reports osDenomination.activated=true")
    }
    const gfsState = await assertGasFeeForkStateConvergence(NODE_IDS)
    ctx.notes.push(
        `gasFeeSeparation activated at block ${gfsState.applied_at_block}`,
    )

    // Sanity: burn account exists with balance 0 BEFORE submission.
    await assertGcrAccountConvergence(
        NODE_IDS,
        BURN_ADDRESS,
        "0",
        "pre-submission burn account",
    )
    void TREASURY_ADDRESS

    // Build + sign the malicious tx.
    const tip = (await Promise.all(
        NODE_IDS.map(id => getGcrAccount(id, kp.pubkeyHex)),
    )).find(r => r !== null)
    if (!tip) {
        throw new Error(
            "Harness keypair not present on any node — genesis injection failed.",
        )
    }
    ctx.notes.push(
        `harness funded on devnet with balance ${tip.balance}`,
    )
    const timestampSec = Math.floor(Date.now() / 1000)
    const tx = buildMaliciousTx(kp.pubkeyHex, timestampSec)
    const { hash, signature } = signHarnessTx(
        kp,
        tx.content,
        ACTIVATION_HEIGHT + 1,
    )
    // Propagate hash onto every gcr_edit's txhash field; the apply
    // layer treats the txhash as a per-edit identifier.
    tx.hash = hash
    tx.signature = signature
    tx.ed25519_signature = signature.data
    for (const e of tx.content.gcr_edits) e.txhash = hash
    ctx.notes.push(`malicious tx hash: ${hash}`)

    // Submit to node-1. The response should signal failure
    // (validityData.data.valid = false) OR carry an error message; we
    // accept any "not happy" shape because the exact rejection
    // mechanism (validation-time vs apply-time) is consensus-internal.
    // The consensus-meaningful assertion comes next.
    const submission = await submitConfirmTx(1, tx)
    ctx.notes.push(
        `node-1 response: HTTP ${submission.status}, body keys=` +
            Object.keys(submission.body ?? {}).join(","),
    )

    // Give the network time to settle (any propagation, mempool
    // sweep, or apply attempt).
    await sleep(15_000)

    // Consensus-critical invariant: burn balance UNCHANGED on every
    // node. If the guard is broken, this is where it surfaces.
    await assertGcrAccountConvergence(
        NODE_IDS,
        BURN_ADDRESS,
        "0",
        "post-submission burn account",
    )
    ctx.notes.push(
        "burn balance verified UNCHANGED on every node after malicious submission",
    )

    // Also confirm fork_state was not mutated by the rejection path.
    const gfsAfter = await assertGasFeeForkStateConvergence(NODE_IDS)
    if (
        String(gfsAfter.applied_at_block) !==
        String(gfsState.applied_at_block)
    ) {
        throw new Error(
            `gasFeeSeparation.applied_at_block drifted: before=${gfsState.applied_at_block} after=${gfsAfter.applied_at_block}`,
        )
    }
    ctx.notes.push("gasFeeSeparation fork_state stable")
}

await runScenarioCli("10-burn-spend-rejection", scenario)
