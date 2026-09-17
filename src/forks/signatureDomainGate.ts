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
 * @param blockHeight - Height to evaluate the fork against. Callers use the
 *   node-local chain tip, never a value taken from the transaction.
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

/** The context for the node-local chain tip. */
export function currentTxSignatureContext(): TxSignatureContext {
    return txSignatureContext(getSharedState.lastBlockNumber ?? 0)
}

/**
 * The bytes to sign for a transaction the node itself produces, resolved at
 * the node-local tip. Node-built transactions (GCR housekeeping, derived
 * mempool operations, signaling-server messages) must commit to the same
 * preimage the validators check, or they stop being accepted the moment the
 * fork activates.
 */
export function txSignaturePreimageForTip(hash: string): Uint8Array {
    const { active, chainId } = currentTxSignatureContext()
    return txSignaturePreimage(hash, chainId, active)
}
