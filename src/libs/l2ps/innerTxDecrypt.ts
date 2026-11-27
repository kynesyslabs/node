import type { L2PSTransaction, Transaction } from "@kynesyslabs/demosdk/types"
import { hexToUint8Array, ucrypto } from "@kynesyslabs/demosdk/encryption"
import { txSignaturePreimage } from "@/libs/crypto/txSignaturePreimage"

/** The part of an SDK `L2PS` instance a decrypt needs. */
export interface InnerTxDecryptor {
    decryptTx(
        encryptedTx: L2PSTransaction,
        options?: { chainId?: number },
    ): Promise<Transaction>
}

/**
 * Why the node opens an envelope.
 *
 * - `admit`: the node is deciding whether to take the inner transaction (RPC
 *   admission, the confirm balance check, a row synced from a peer that the
 *   aggregator is about to settle). Its signature must cover exactly the
 *   preimage an L1 transaction admitted now must cover.
 * - `stored`: the node reads a row it already took (queued-transfer totals,
 *   account history). Either preimage is accepted once the fork is active, so
 *   a row admitted with a legacy signature before activation still opens.
 */
export type InnerTxUse = "admit" | "stored"

export const INNER_TX_NOT_DOMAIN_SIGNED =
    "Decrypted transaction signature does not cover this chain's signature domain"

/**
 * Decrypt an L2PS envelope and check its inner transaction's signature by the
 * rule L1 admission applies to the block it would land in.
 *
 * Judged at the tip plus one with the genesis chain id, as
 * `Transaction.validateSignature` judges an L1 transaction. No validator
 * decrypts an inner transaction when it checks a block: a settled batch is
 * judged by its settlement signatures, which bind the genesis chain id, and
 * its proof. So this rule decides only what a member takes, and cannot split
 * validators.
 *
 * Before activation the SDK is given no chain id, so only the legacy preimage
 * verifies, exactly as before. After activation the SDK accepts the domain
 * form and the legacy form; for `admit` the legacy form is refused here, as
 * L1 refuses it.
 */
export async function decryptInnerTx(
    l2ps: InnerTxDecryptor,
    encryptedTx: L2PSTransaction,
    use: InnerTxUse = "admit",
): Promise<Transaction> {
    // Loaded on first use: the gate reads shared state, which pulls in the
    // whole node, and the L2PS RPC handler must stay importable without it.
    const { pendingTxSignatureContext } = await import("@/forks/signatureDomainGate")
    const { active, chainId } = pendingTxSignatureContext()
    if (!active) return await l2ps.decryptTx(encryptedTx)
    const inner = await l2ps.decryptTx(encryptedTx, { chainId })
    if (use === "admit" && !(await signedForChain(inner, chainId))) {
        throw new Error(INNER_TX_NOT_DOMAIN_SIGNED)
    }
    return inner
}

/** Whether `tx.content.from` signed `demos-tx:v1:<chainId>:<tx.hash>`. */
async function signedForChain(tx: Transaction, chainId: number): Promise<boolean> {
    try {
        return await ucrypto.verify({
            algorithm: tx.signature.type,
            message: txSignaturePreimage(tx.hash, chainId, true),
            publicKey: hexToUint8Array(tx.content.from as string),
            signature: hexToUint8Array(tx.signature.data),
        })
    } catch {
        // A malformed key or signature, or an unknown algorithm, is a
        // signature that does not verify.
        return false
    }
}
