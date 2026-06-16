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
// Import the serializer via the DIRECT build path (NOT the SDK barrel), same
// reason as unifiedCrypto above: the barrel transitively loads zK/ffjavascript
// which crashes inside a worker_thread. serializerGate.js only pulls
// constants.js + conversion.js, both worker-safe (audit H1).
import { serializeTransactionContent } from "../../../../node_modules/@kynesyslabs/demosdk/build/denomination/serializerGate.js"
import Hashing from "../../crypto/hashing"
import type { PqcIdentityHint, TxValidationResult } from "./types"

/**
 * Coherence: SHA-256 of the CANONICAL serialization of tx.content === tx.hash.
 *
 * Must use the SAME canonicalization the signer/consensus use
 * (serializeTransactionContent), or a post-osDenomination tx whose hash was
 * committed over OS-string amounts diverges from a raw JSON.stringify and a
 * legit tx is wrongly rejected — or, worse, one node admits a tx whose hash
 * disagrees with what peers recompute at block time (consensus divergence).
 * Audit H1.
 *
 * `isPostFork` is computed on the MAIN thread (where forkConfig + chain height
 * live) and threaded in, because the worker has neither. Pre-fork
 * (isPostFork=false) the SDK serializer returns JSON.stringify(content) —
 * byte-identical to the legacy behaviour, so re-sync stays safe. No I/O, no
 * logger (worker-safe).
 */
export function validateTxCoherence(
    tx: Transaction,
    isPostFork: boolean,
): TxValidationResult {
    let content = tx.content
    if (Array.isArray(content?.gcr_edits)) {
        const strippedEdits = content.gcr_edits.map(edit => {
            if (!("expectedPrior" in edit)) {
                return edit
            }

            const stripped = { ...edit }
            delete (stripped as { expectedPrior?: number }).expectedPrior
            return stripped
        })
        content = { ...content, gcr_edits: strippedEdits }
    }

    const derivedHash = Hashing.sha256(
        serializeTransactionContent(content, isPostFork),
    )

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
        // ed25519 path: the signer IS the ed25519 identity, so `from` (the key
        // the main signature is verified against) and `from_ed25519_address`
        // (the recorded ed25519 identity used by downstream identity/IM logic)
        // MUST be the same key. Without this check (audit H2) a tx could be
        // signed by `from` while recording a DIFFERENT `from_ed25519_address`,
        // an identity-confusion: the signer pays but another address is logged
        // as the ed25519 identity. The optional-`sender` ownership precheck in
        // Transaction.validateSignature never runs on this pure gossip path, so
        // enforce equality here. (PQC branches above legitimately differ:
        // `from` is the PQC key, `from_ed25519_address` the ed25519 co-signer.)
        const from = (tx.content.from as string) ?? ""
        const fromEd = (tx.content.from_ed25519_address as string) ?? ""
        if (from.toLowerCase() !== fromEd.toLowerCase()) {
            return {
                hash: tx.hash,
                valid: false,
                reason: "ed25519 tx 'from' does not match 'from_ed25519_address'",
            }
        }
        // The single verify below IS the main signature.
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
    isPostFork: boolean,
): Promise<TxValidationResult> {
    const coherence = validateTxCoherence(tx, isPostFork)
    if (!coherence.valid) return coherence
    return await validateTxSignature(tx, hint)
}
