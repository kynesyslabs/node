import crypto from "crypto"
import Hashing from "@/libs/crypto/hashing"
import { jcsCanonicalize } from "@/libs/crypto/jcs"
import { leafDigest } from "@/libs/atomic-work/digest"

/**
 * Per-operation evidence hashes: input and output hashes, the business-state
 * roots, and the merkle root over operation results. All are plain
 * JCS-over-sha256 except the merkle leaf, which is domain-separated so a leaf
 * can never be replayed as an interior node. The leaf's domain belongs to the
 * profile and arrives as a parameter.
 */

function jcsBytes(value: unknown): Buffer {
    return Buffer.from(jcsCanonicalize(value), "utf-8")
}
function sha256(buf: Buffer): Buffer {
    return crypto.createHash("sha256").update(buf).digest()
}

/** inputHash = sha256(JCS(payload)). */
export function computeInputHash(payload: unknown): string {
    return Hashing.sha256Bytes(jcsBytes(payload))
}

/** stateRoot = sha256(JCS(state)); used for businessState pre/postRoot. */
export function computeStateRoot(state: Record<string, unknown>): string {
    return Hashing.sha256Bytes(jcsBytes(state))
}

/** effectsRoot = sha256(JCS({ pre, post })). */
export function computeEffectsRoot(
    preState: Record<string, unknown>,
    postState: Record<string, unknown>,
): string {
    return Hashing.sha256Bytes(jcsBytes({ pre: preState, post: postState }))
}

/**
 * outputHash for a committed operation:
 *  - storage-program-put  → sha256(JCS(storageOutput))
 *  - native-dem-transfer  → sha256(JCS(payload))
 *  - otherwise            → sha256(JCS({ accepted: true, operationId }))
 */
export function computeOutputHash(op: {
    kind: string
    payload?: unknown
    storageOutput?: unknown
    operationId?: string
}): string {
    if (op.kind === "storage-program-put")
        return Hashing.sha256Bytes(jcsBytes(op.storageOutput))
    if (op.kind === "native-dem-transfer")
        return Hashing.sha256Bytes(jcsBytes(op.payload))
    return Hashing.sha256Bytes(jcsBytes({ accepted: true, operationId: op.operationId }))
}

/** Bit length of a non-negative integer (n.toString(2).length; 0 → 0). */
function bitLength(n: number): number {
    return n === 0 ? 0 : n.toString(2).length
}

/**
 * RFC-6962-style merkle root (0x01 internal prefix, largest-power-of-2 split).
 * Leaves already hashed; empty → sha256(""), single → the leaf verbatim.
 */
function merkleRootFromHashes(hashes: Buffer[]): Buffer {
    if (hashes.length === 0) return sha256(Buffer.alloc(0))
    if (hashes.length === 1) return hashes[0]
    const split = 1 << (bitLength(hashes.length - 1) - 1)
    return sha256(
        Buffer.concat([
            Buffer.from([0x01]),
            merkleRootFromHashes(hashes.slice(0, split)),
            merkleRootFromHashes(hashes.slice(split)),
        ]),
    )
}

/** operationReceiptRoot = merkle root over the leaf-hashed operation results. */
export function computeOperationReceiptRoot(
    results: unknown[],
    domain: string,
): string {
    return merkleRootFromHashes(
        results.map((leaf) => leafDigest(domain, leaf)),
    ).toString("hex")
}
