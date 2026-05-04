import { Transaction } from "@kynesyslabs/demosdk/types"
import type { SigningAlgorithm } from "@kynesyslabs/demosdk/types"
// Import unifiedCrypto.js directly instead of "@kynesyslabs/demosdk/encryption":
// the package index re-exports zK, which transitively loads ffjavascript →
// web-worker. web-worker auto-runs its workerThread() startup against the host
// worker's workerData and throws TypeError: Cannot destructure property 'mod'
// from null, killing the worker before any handlers run. Going straight to
// unifiedCrypto.js avoids zK (and FHE/SEAL) and keeps this file safe to load
// inside a worker_threads / Bun Worker.
import {
    unifiedCrypto as ucrypto,
    hexToUint8Array,
} from "../../../../node_modules/@kynesyslabs/demosdk/build/encryption/unifiedCrypto.js"
import Hashing from "../../crypto/hashing"
import type { PqcIdentityHint, TxValidationResult } from "./types"

/**
 * SHA-256(JSON.stringify(content)) === tx.hash. No I/O, no logger.
 */
export function validateTxCoherence(tx: Transaction): TxValidationResult {
    const derivedHash = Hashing.sha256(JSON.stringify(tx.content))
    if (derivedHash !== tx.hash) {
        return {
            hash: tx.hash,
            valid: false,
            reason: "Transaction is not coherent",
        }
    }
    return { hash: tx.hash, valid: true }
}

/**
 * Pure signature validation. Same semantics as `TxUtils.validateSignature`
 * (without the optional `sender` argument) but consults `hint` instead of
 * `IdentityManager.getIdentities` for the PQC-no-co-signature branch.
 *
 * Error messages preserved byte-for-byte for downstream consumers.
 */
export async function validateTxSignature(
    tx: Transaction,
    hint: PqcIdentityHint,
): Promise<TxValidationResult> {
    let ed25519SignatureVerified = false

    if (tx.signature.type !== "ed25519") {
        if (!tx.ed25519_signature) {
            // PQC without co-signature: verify ownership via the prefetched identity record.
            if (!hint) {
                return {
                    hash: tx.hash,
                    valid: false,
                    reason:
                        "Transaction is missing ed25519 signature, and the PQC signer is not added as an identity. Please provide an ed25519 signature or add the PQC signer as an identity for " +
                        tx.content.from_ed25519_address,
                }
            }
            ed25519SignatureVerified = await ucrypto.verify({
                algorithm: "ed25519",
                message: new TextEncoder().encode(hint.address),
                publicKey: hexToUint8Array(tx.content.from_ed25519_address),
                signature: hexToUint8Array(hint.signature),
            })
        } else {
            // PQC with co-signature: verify the supplied ed25519 signature against tx.hash.
            ed25519SignatureVerified = await ucrypto.verify({
                algorithm: "ed25519",
                message: new TextEncoder().encode(tx.hash),
                publicKey: hexToUint8Array(tx.content.from_ed25519_address),
                signature: hexToUint8Array(tx.ed25519_signature),
            })
        }
    } else {
        // ed25519 path: no separate ownership precheck. The single verify below IS the main signature.
        ed25519SignatureVerified = true
    }

    if (!ed25519SignatureVerified) {
        return {
            hash: tx.hash,
            valid: false,
            reason: "Ed25519 signature verification failed",
        }
    }

    const mainSignatureVerified = await ucrypto.verify({
        algorithm: tx.signature.type as SigningAlgorithm,
        message: new TextEncoder().encode(tx.hash),
        publicKey: hexToUint8Array(tx.content.from as string),
        signature: hexToUint8Array(tx.signature.data),
    })

    return mainSignatureVerified
        ? { hash: tx.hash, valid: true }
        : {
              hash: tx.hash,
              valid: false,
              reason: "Transaction signature verification failed",
          }
}

/**
 * Full validation pipeline used by `Mempool.receive`: coherence first, then
 * signature. Short-circuits on the first failure.
 */
export async function validateTx(
    tx: Transaction,
    hint: PqcIdentityHint,
): Promise<TxValidationResult> {
    const coherence = validateTxCoherence(tx)
    if (!coherence.valid) return coherence
    return await validateTxSignature(tx, hint)
}
