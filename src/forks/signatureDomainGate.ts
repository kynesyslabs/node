import { getSharedState } from "@/utilities/sharedState"
import { isForkActive } from "./forkGates"
import { txSignaturePreimage } from "@/libs/crypto/txSignaturePreimage"

/**
 * The two facts a transaction signature preimage depends on: whether the
 * `signatureDomain` fork applies at the height being processed, and the chain
 * id the signature binds to.
 *
 * Resolved on the main thread and threaded into validator workers, the same
 * way `osDenomination` is threaded into the coherence check — a worker has
 * neither the fork config nor the chain height.
 */
export interface TxSignatureContext {
    active: boolean
    chainId: number
}

/**
 * Resolve the signature context for a height.
 *
 * Fails closed on a misconfigured chain: if the fork is active but genesis
 * declared no `properties.id`, there is no id to bind to, and binding to a
 * default would let a signature made here verify on another chain that picked
 * the same default. Refusing to produce a context stops the node rather than
 * letting it sign or accept ambiguous transactions.
 *
 * @param blockHeight - Height to evaluate the fork against. Callers derive it
 *   from node-local state — the block being validated, or the tip plus one
 *   when admitting — never from a value carried by the transaction.
 */
export function txSignatureContext(blockHeight: number): TxSignatureContext {
    const active = isForkActive("signatureDomain", blockHeight)
    if (!active) {
        // chainId is unused while inactive; the legacy preimage carries no id.
        return { active: false, chainId: 0 }
    }
    const chainId = getSharedState.chainId
    if (chainId === null) {
        throw new Error(
            "[FORKS] signatureDomain is active but genesis declared no properties.id — " +
                "cannot bind transaction signatures to a chain",
        )
    }
    return { active: true, chainId }
}

/**
 * The context for the block a transaction being admitted now would land in.
 *
 * That is the tip plus one, not the tip. A transaction accepted while the
 * chain sits at H-1 is included in block H, and the rule that judges it is
 * the rule at H. Resolving at the tip would admit and sign legacy bare-hash
 * signatures for the activation block itself, which the validators then
 * reject — the fork would break its own first block.
 */
export function pendingTxSignatureContext(): TxSignatureContext {
    return txSignatureContext((getSharedState.lastBlockNumber ?? 0) + 1)
}

/**
 * The bytes to sign for a transaction the node itself produces, resolved for
 * the block it would land in. Node-built transactions (GCR housekeeping,
 * derived mempool operations, signaling-server messages) must commit to the
 * same preimage the validators check, or they stop being accepted the moment
 * the fork activates.
 */
export function txSignaturePreimageForPendingBlock(hash: string): Uint8Array {
    const { active, chainId } = pendingTxSignatureContext()
    return txSignaturePreimage(hash, chainId, active)
}
