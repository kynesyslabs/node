import type { Transaction } from "@kynesyslabs/demosdk/types"
import { hexToUint8Array } from "@kynesyslabs/demosdk/encryption"
import Hashing from "src/libs/crypto/hashing"
import { BATCH_SIGNATURE_DOMAIN } from "@/libs/l2ps/constants"
import TxValidatorPool from "./txValidatorPool"

/**
 * Node-generated relay transactions that are not signed the way a user
 * transaction is. The L2PS batch aggregator hashes the plain
 * `JSON.stringify(content)` and signs `${BATCH_SIGNATURE_DOMAIN}:${content}`
 * with the node key, so the user-transaction check (a signature over the
 * hash preimage) can never accept one.
 *
 * Nothing on the mempool receive path verifies this form: the mempool only
 * exempts these types from the per-account nonce throttle, and a remote
 * validator's receive refuses them. They reach a block only from the
 * originating node's own mempool, which is why a syncing node has to verify
 * the form itself instead of trusting the type.
 *
 * The L2PS consensus summary transaction (`from: "l2ps:consensus"`, empty
 * signature) is written straight to the transactions table and never enters
 * a mempool or `ordered_transactions`, so it has no valid form here.
 */
const SYSTEM_RELAY_TX_TYPES = new Set<string>(["l2psBatch"])

export interface SystemRelayVerdict {
    valid: boolean
    reason?: string
}

export function isSystemRelayTx(tx: Transaction): boolean {
    return SYSTEM_RELAY_TX_TYPES.has(tx?.content?.type as string)
}

export async function verifySystemRelayTx(
    tx: Transaction,
): Promise<SystemRelayVerdict> {
    const signature = tx.signature as
        | { type?: string; data?: string; domain?: string }
        | null
        | undefined
    if (!signature?.data || !signature.type) {
        return { valid: false, reason: "system relay transaction is unsigned" }
    }
    if (signature.domain !== BATCH_SIGNATURE_DOMAIN) {
        return {
            valid: false,
            reason: "system relay transaction carries the wrong signature domain",
        }
    }

    const contentString = JSON.stringify(tx.content)
    if (Hashing.sha256(contentString) !== tx.hash) {
        return { valid: false, reason: "Transaction is not coherent" }
    }

    try {
        const ok = await TxValidatorPool.getInstance().verify({
            algorithm: signature.type as never,
            message: new TextEncoder().encode(
                `${BATCH_SIGNATURE_DOMAIN}:${contentString}`,
            ),
            signature: hexToUint8Array(signature.data),
            publicKey: hexToUint8Array(tx.content.from as string),
        })
        return ok
            ? { valid: true }
            : {
                  valid: false,
                  reason: "system relay transaction signature verification failed",
              }
    } catch (e) {
        return {
            valid: false,
            reason: `system relay transaction signature could not be verified: ${e instanceof Error ? e.message : String(e)}`,
        }
    }
}
