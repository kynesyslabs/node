import crypto from "crypto"
import Hashing from "@/libs/crypto/hashing"
import { jcsCanonicalize } from "@/libs/crypto/jcs"

/**
 * DACS §A.6 / D6 evidence hashes: per-operation input/output hashes, the
 * operation-receipt merkle root, and the business-state roots. All are pure
 * JCS-over-sha256 (no domain prefix) except the merkle leaf, which is
 * domain-separated. Byte-exact ports of the DACS reference.
 */
export const OP_RECEIPT_DOMAIN = "dacs-atomic-operation-receipt:v1:"

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

/** operationLeafHash = sha256(0x00 ‖ OP_RECEIPT_DOMAIN ‖ JCS(leaf)). */
function operationLeafHash(leaf: unknown): Buffer {
    return sha256(
        Buffer.concat([
            Buffer.from([0x00]),
            Buffer.from(OP_RECEIPT_DOMAIN, "ascii"),
            jcsBytes(leaf),
        ]),
    )
}

/** operationReceiptRoot = merkle root over the leaf-hashed operation results. */
export function computeOperationReceiptRoot(results: unknown[]): string {
    return merkleRootFromHashes(results.map(operationLeafHash)).toString("hex")
}
