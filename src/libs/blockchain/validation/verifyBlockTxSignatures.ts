import type { Block, Transaction } from "@kynesyslabs/demosdk/types"

import { isForkActive } from "@/forks/forkGates"
import { txSignatureContext } from "@/forks/signatureDomainGate"
import TxValidatorPool from "./txValidatorPool"
import { isSystemRelayTx, verifySystemRelayTx } from "./systemRelayTx"

export interface BlockTxSignatureVerdict {
    valid: boolean
    reason?: string
}

/**
 * Check the transactions of an already-sealed block against the rules that
 * applied at that block's own height.
 *
 * Mempool admission judges a transaction for the next block (tip + 1), which
 * says nothing about a block that is already history: a node catching up
 * replays blocks from before and after `signatureDomain` activated, and a
 * proposer is free to include a transaction it never validated. Judging at
 * the block's height reproduces the verdict the rest of the network reached
 * when the block was made: legacy bare-hash signatures below the activation
 * height, `demos-tx:v1:<chainId>:<hash>` from it on, and a signature made for
 * another chain id never verifies.
 *
 * Coherence (hash vs content) is checked in the same pass because a signature
 * only covers the hash: a valid signature over a hash that does not describe
 * the shipped content proves nothing about the content.
 *
 * The supplied transactions must be exactly the block's `ordered_transactions`:
 * every listed hash once, nothing extra. An empty list for a block that lists
 * transactions is invalid, not vacuously fine.
 *
 * System relay types (`l2psBatch`) are signed under their producer's own rule
 * and are checked by that rule; every other type goes through the standard
 * coherence and preimage check.
 *
 * Identity state is NOT judged at the block's height. A PQC transaction
 * without an Ed25519 co-signature is checked against the signer's current
 * identity record, because the node keeps no per-height identity history
 * (removing a key deletes the record). The verdict is therefore exact only
 * when the check runs before the block is applied, in height order, which is
 * how a syncing node uses it: the stored identities are then the ones the
 * block's own transactions were admitted against. Re-checking an old,
 * already-applied block can reject a PQC transaction whose key was removed
 * later; a caller that needs that must supply historical identity records.
 *
 * @param block - The block the transactions were included in.
 * @param txs - The transactions received for that block.
 */
export async function verifyBlockTxSignatures(
    block: Pick<Block, "number" | "content">,
    txs: Transaction[],
): Promise<BlockTxSignatureVerdict> {
    // Genesis carries a synthetic transaction nobody signed.
    if (block.number === 0) {
        return { valid: true }
    }

    const listed = block.content.ordered_transactions
    const ordered = new Set(listed)
    if (ordered.size !== listed.length) {
        return {
            valid: false,
            reason: `block ${block.number} lists a transaction more than once`,
        }
    }
    const seen = new Set<string>()
    for (const tx of txs) {
        if (!ordered.has(tx.hash)) {
            return {
                valid: false,
                reason: `transaction ${tx.hash} is not part of block ${block.number}`,
            }
        }
        if (seen.has(tx.hash)) {
            return {
                valid: false,
                reason: `transaction ${tx.hash} supplied twice for block ${block.number}`,
            }
        }
        seen.add(tx.hash)
    }
    if (seen.size !== ordered.size) {
        return {
            valid: false,
            reason: `${ordered.size - seen.size} of ${ordered.size} transactions listed by block ${block.number} were not supplied`,
        }
    }
    if (txs.length === 0) {
        return { valid: true }
    }

    const relay = txs.filter(isSystemRelayTx)
    const standard = txs.filter(tx => !isSystemRelayTx(tx))

    for (const tx of relay) {
        const verdict = await verifySystemRelayTx(tx)
        if (!verdict.valid) {
            return {
                valid: false,
                reason: `transaction ${tx.hash} in block ${block.number}: ${verdict.reason}`,
            }
        }
    }

    if (standard.length === 0) {
        return { valid: true }
    }

    let signatureDomain
    try {
        signatureDomain = txSignatureContext(block.number)
    } catch (e) {
        return {
            valid: false,
            reason: `cannot resolve signature context for block ${block.number}: ${e instanceof Error ? e.message : String(e)}`,
        }
    }
    const isPostFork = isForkActive("osDenomination", block.number)

    const results = await TxValidatorPool.getInstance().validate(
        standard,
        isPostFork,
        signatureDomain,
    )
    for (let i = 0; i < results.length; i++) {
        if (!results[i].valid) {
            return {
                valid: false,
                reason: `transaction ${standard[i].hash} in block ${block.number}: ${results[i].reason}`,
            }
        }
    }
    return { valid: true }
}
