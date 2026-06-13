/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

/**
 * verifyGcrEdits — bind a transaction's shipped `gcr_edits` to the edits the
 * node would deterministically regenerate from the signed tx body.
 *
 * WHY THIS EXISTS (audit C1):
 * A native tx carries `gcr_edits[]` describing the balance/nonce mutations it
 * will cause. The signature proves the SENDER authored the tx — it does NOT
 * prove the attached edits are legitimate, because a self-signed tx can carry
 * any forged edit (e.g. `{balance, add, self, HUGE}` with no matching remove).
 * The only thing that proves edit legitimacy is regenerating the expected edit
 * set from `tx.content` via `GCRGeneration.generate` and comparing.
 *
 * That binding used to live ONLY inside `handleValidateTransaction` (the local
 * `execute`/`confirmTx` RPC). The peer-gossip `mempool` ingress and the
 * consensus apply path never ran it, so a forged-edit tx admitted via gossip
 * was applied by every validator — an unauthenticated balance mint. This
 * module extracts the check so the mempool-admission path can reject forged
 * edits before they ever enter the mempool (a non-consensus, admission-side
 * defence; apply-time enforcement is tracked separately as a fork-gated fix).
 *
 * The function is pure-ish: it reads chain height + the active denomination
 * fork to normalise edit shapes, regenerates, and compares hashes. It NEVER
 * throws on a mismatch — it returns a structured result so the caller decides
 * how to react (reject-at-ingress vs throw-at-execute).
 */

import type { Transaction, GCREdit } from "@kynesyslabs/demosdk/types"
import { GCRGeneration } from "@kynesyslabs/demosdk/websdk"
import { denomination } from "@kynesyslabs/demosdk"

import Chain from "src/libs/blockchain/chain"
import Hashing from "src/libs/crypto/hashing"
import { isForkActive } from "@/forks/forkGates"
import { getSharedState } from "@/utilities/sharedState"
import { generateFeeDistributionEdits } from "@/libs/blockchain/gcr/gcr_routines/feeDistribution"
import { forgeToHex } from "@/libs/crypto/forgeUtils"
import log from "src/utilities/logger"

export interface GcrEditsVerification {
    /** true when the shipped edits match the regenerated set. */
    match: boolean
    /** sha256 of the normalised tx-shipped edits (for diagnostics). */
    txEditsHash: string
    /** sha256 of the normalised regenerated edits (for diagnostics). */
    regenEditsHash: string
}

/**
 * Strip fields that one side populates and the other blanks, so the hash is
 * invariant under those choices:
 *   - `txhash`: SDK ships it empty; some flows propagate the parent hash.
 *   - `expectedPrior` on nonce edits: SDK type allows it but never writes it;
 *     the node fills it at validation time. (Audit-sweep batch C PR 3.)
 */
function blankVolatileEditFields(edit: GCREdit): GCREdit {
    const blanked: GCREdit = { ...edit, txhash: "" }
    if (blanked.type === "nonce" && "expectedPrior" in blanked) {
        delete (blanked as { expectedPrior?: number }).expectedPrior
    }
    return blanked
}

/**
 * Verify that `tx.content.gcr_edits` equals the edits regenerated from the
 * signed tx body. Pure: does not mutate `tx` and never throws on mismatch
 * (only on an unexpected internal failure, which the caller should treat as
 * "could not verify" → reject).
 *
 * IMPORTANT: call this with the SDK-shipped edits intact — i.e. BEFORE any
 * code (e.g. `applyGasFeeSeparation` inside `confirmTransaction`) prepends
 * node-computed fee edits onto `tx.content.gcr_edits`. At mempool ingress the
 * array is still the raw shipped set, which is exactly what we want.
 */
export async function verifyGcrEditsMatch(
    tx: Transaction,
    options: { expectFeeEdits?: boolean } = {},
): Promise<GcrEditsVerification> {
    // expectFeeEdits distinguishes WHERE the tx is being checked:
    //   - APPLY time (block txs, post-confirmTransaction): the shipped edits
    //     carry node-computed gasFeeSeparation fee edits, so the regen must
    //     reproduce them too -> pass true.
    //   - INGRESS time (peer gossip, pre-confirmTransaction): the shipped edits
    //     are the raw SDK shape with NO fee edits, so the regen must NOT add
    //     them -> pass false (default).
    const { expectFeeEdits = false } = options

    // Snapshot the shipped edits (deep copy) so nothing downstream observes a
    // mutation from this read-only check.
    const txShippedGcrEdits: GCREdit[] = JSON.parse(
        JSON.stringify(tx.content.gcr_edits ?? []),
    )

    // Regenerate the expected edit set from the signed body.
    const regen = await GCRGeneration.generate(tx)

    // When gasFeeSeparation is active, confirmTransaction PREPENDS
    // node-computed fee-distribution edits onto tx.content.gcr_edits before the
    // tx is stored/gossiped/applied (applyGasFeeSeparation,
    // validateTransaction.ts). The shipped edits therefore carry those fee
    // edits, but GCRGeneration.generate does NOT emit them — so a naive compare
    // would mismatch every legit tx (audit C1-apply / 184). Reproduce them on
    // the regen side and prepend, matching the shipped ordering.
    //
    // CRITICAL: derive the fee edits from the SHIPPED transaction_fee
    // (amounts + rpc_address), NOT by re-running applyGasFeeSeparation —
    // that re-stamps rpc_address with THIS node's pubkey, so a verifying node
    // would route the rpc-fee to itself and diverge from the originator's
    // edits, false-rejecting every cross-node tx. generateFeeDistributionEdits
    // is a pure function of (sender, shipped rpc_address, shipped fee amounts,
    // txHash) + the deterministic fee-distribution config, so feeding it the
    // shipped values reproduces the originator's exact fee edits on any node.
    const gasFeeActive = isForkActive(
        "gasFeeSeparation",
        getSharedState.lastBlockNumber ?? 0,
    )
    if (expectFeeEdits && gasFeeActive && tx.content?.type === "native") {
        const fee = tx.content.transaction_fee
        if (fee) {
            const senderAddress =
                typeof tx.content.from === "string"
                    ? tx.content.from
                    : forgeToHex(tx.content.from as never)
            const feeEdits = generateFeeDistributionEdits({
                senderAddress,
                rpcAddress: fee.rpc_address ?? null,
                networkFee: Number(fee.network_fee),
                rpcFee: Number(fee.rpc_fee),
                additionalFee: Number(fee.additional_fee),
                txHash: tx.hash ?? "",
                isRollback: false,
            })
            // Prepend to match applyGasFeeSeparation's ordering
            // ([fee edits..., base edits]).
            regen.unshift(...(feeEdits as unknown as GCREdit[]))
        }
    }

    regen.forEach((gcredit: GCREdit) => {
        gcredit.txhash = ""
        if (gcredit.type === "nonce" && "expectedPrior" in gcredit) {
            delete (gcredit as { expectedPrior?: number }).expectedPrior
        }
    })

    // Both sides must be normalised through the SAME canonical wire-shape
    // transform the SDK applies (post-fork OS amount strings vs raw author
    // shape), or identical edit sets hash differently. Block height comes from
    // the local chain tip — never from the tx (tx.blockNumber is attacker
    // controlled). osDenomination gate decides the amount encoding.
    const blockHeight = await Chain.getLastBlockNumber()
    const postFork = isForkActive("osDenomination", blockHeight)

    const normalise = (edits: GCREdit[]): GCREdit[] => {
        const envelope = {
            ...tx.content,
            gcr_edits: edits,
        }
        const serialised = denomination.serializeTransactionContent(
            envelope as any,
            postFork,
        )
        const parsed = JSON.parse(serialised) as { gcr_edits: GCREdit[] }
        return parsed.gcr_edits ?? []
    }

    const normalisedRegen = normalise(regen)
    const regenEditsHash = Hashing.sha256(JSON.stringify(normalisedRegen))

    const normalisedTxEdits = normalise(
        txShippedGcrEdits.map(blankVolatileEditFields),
    )
    const txEditsHash = Hashing.sha256(JSON.stringify(normalisedTxEdits))

    const match = txEditsHash === regenEditsHash
    if (!match) {
        log.error(
            `[verifyGcrEditsMatch] GCREdit mismatch ${txEditsHash} <> ${regenEditsHash} ` +
                `(tx ${tx.hash})`,
        )
    }
    return { match, txEditsHash, regenEditsHash }
}
