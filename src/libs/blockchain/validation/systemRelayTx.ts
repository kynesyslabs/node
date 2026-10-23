import type { Transaction } from "@kynesyslabs/demosdk/types"
import {
    unifiedCrypto as ucrypto,
    hexToUint8Array,
} from "../../../../node_modules/@kynesyslabs/demosdk/build/encryption/unifiedCrypto.js"

import Hashing from "@/libs/crypto/hashing"
import { BATCH_SIGNATURE_DOMAIN } from "@/libs/l2ps/constants"
import type { TxValidationResult } from "./types"

/**
 * Types of node-generated relay transactions that do not follow the standard
 * transaction signing rules. Keep in step with the set mempool admission uses
 * to skip the per-account nonce check.
 */
const SYSTEM_RELAY_TX_TYPES = new Set<string>(["l2psBatch"])

/** `from` of the unsigned local record the L2PS consensus step writes. */
const L2PS_CONSENSUS_SENDER = "l2ps:consensus"

/**
 * Whether a transaction is a system relay type, judged by its content type
 * only. Being one selects which verifier applies; it exempts nothing.
 */
export function isSystemRelayTx(tx: Transaction): boolean {
    const type = (tx?.content as { type?: unknown } | undefined)?.type
    return typeof type === "string" && SYSTEM_RELAY_TX_TYPES.has(type)
}

/**
 * Verify a system relay transaction by the rule its producer signs under.
 *
 * `l2psBatch` is built by the L2PS batch aggregator: the hash is the SHA-256
 * of the raw `JSON.stringify(content)` (no denomination canonicalization), and
 * the node key signs `${BATCH_SIGNATURE_DOMAIN}:${JSON.stringify(content)}`,
 * not the transaction hash. Neither matches the standard coherence or
 * preimage check, and the receiving mempool does not accept these through
 * its standard validation, so a block that carries one has to be judged by
 * the producer's own rule or not at all.
 *
 * The signer is not checked against the validator set here: any key that
 * signs its own batch transaction passes. Admission to a block is the
 * proposer's decision; this check proves only that the content was signed
 * by the key it names.
 *
 * The L2PS consensus step also writes a transaction of this type with an
 * empty signature and `from: "l2ps:consensus"`. It goes straight into the
 * transactions table after the block's contents are fixed and is never in a
 * block's `ordered_transactions`, so a block that does list one is rejected
 * rather than exempted.
 */
export async function verifySystemRelayTx(
    tx: Transaction,
): Promise<TxValidationResult> {
    const hash = tx?.hash
    const invalid = (reason: string): TxValidationResult => ({
        hash,
        valid: false,
        reason,
    })

    if (!isSystemRelayTx(tx)) {
        return invalid("not a system relay transaction")
    }
    const content = tx.content as Record<string, any>

    if (
        content.from === L2PS_CONSENSUS_SENDER ||
        typeof tx.signature?.data !== "string" ||
        tx.signature.data.length === 0
    ) {
        return invalid(
            "unsigned system transaction cannot be part of a block's ordered transactions",
        )
    }

    if (!Array.isArray(content.data) || content.data[0] !== content.type) {
        return invalid("system relay payload does not match its type")
    }

    const contentString = JSON.stringify(content)
    if (Hashing.sha256(contentString) !== hash) {
        return invalid("Transaction is not coherent")
    }

    try {
        const ok = await ucrypto.verify({
            algorithm: tx.signature.type,
            message: new TextEncoder().encode(
                `${BATCH_SIGNATURE_DOMAIN}:${contentString}`,
            ),
            signature: hexToUint8Array(tx.signature.data),
            publicKey: hexToUint8Array(content.from),
        })
        return ok
            ? { hash, valid: true }
            : invalid("system relay signature verification failed")
    } catch (e) {
        return invalid(
            `system relay signature check threw: ${e instanceof Error ? e.message : String(e)}`,
        )
    }
}
