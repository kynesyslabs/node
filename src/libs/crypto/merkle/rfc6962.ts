/**
 * Merkle tree of RFC 6962 (Certificate Transparency), SHA-256.
 *
 * A block's transaction results are committed as this tree so a client can
 * check one result with log2(n) hashes, using any existing CT tooling as a
 * reference. The 0x00 / 0x01 prefixes keep a leaf from passing as an inner
 * node (second-preimage), and splitting at the largest power of two below n
 * fixes one shape per size, so the root is a function of the leaf list alone.
 */

import { sha256 } from "@noble/hashes/sha2.js"
import { bytesEqual, fromHex, toHex, type HashInput } from "./hex"

const LEAF_PREFIX = Uint8Array.of(0x00)
const NODE_PREFIX = Uint8Array.of(0x01)

/** Root of the empty tree: sha256 of the empty string. */
export const EMPTY_ROOT: Uint8Array = sha256(new Uint8Array(0))

export function leafHash(data: Uint8Array): Uint8Array {
    return sha256.create().update(LEAF_PREFIX).update(data).digest()
}

export function nodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
    return sha256.create().update(NODE_PREFIX).update(left).update(right).digest()
}

/** Largest power of two strictly smaller than n, for n >= 2. */
function splitPoint(n: number): number {
    let k = 1
    while (k * 2 < n) k *= 2
    return k
}

function subtreeRoot(hashes: Uint8Array[], lo: number, hi: number): Uint8Array {
    const n = hi - lo
    if (n === 1) return hashes[lo]
    const k = splitPoint(n)
    return nodeHash(subtreeRoot(hashes, lo, lo + k), subtreeRoot(hashes, lo + k, hi))
}

/** MTH(D[n]) over the leaves' data, in order. */
export function root(leaves: Uint8Array[]): Uint8Array {
    if (leaves.length === 0) return EMPTY_ROOT
    return subtreeRoot(leaves.map(leafHash), 0, leaves.length)
}

function subtreePath(hashes: Uint8Array[], index: number, lo: number, hi: number): Uint8Array[] {
    const n = hi - lo
    if (n === 1) return []
    const k = splitPoint(n)
    if (index < lo + k) {
        return [...subtreePath(hashes, index, lo, lo + k), subtreeRoot(hashes, lo + k, hi)]
    }
    return [...subtreePath(hashes, index, lo + k, hi), subtreeRoot(hashes, lo, lo + k)]
}

/**
 * PATH(index, D[n]): the sibling hashes from the leaf up to the root, the
 * order CT and RFC 9162 use.
 */
export function auditPath(leaves: Uint8Array[], index: number): Uint8Array[] {
    if (!Number.isSafeInteger(index) || index < 0 || index >= leaves.length) {
        throw new RangeError(`rfc6962: index ${index} outside a tree of ${leaves.length}`)
    }
    return subtreePath(leaves.map(leafHash), index, 0, leaves.length)
}

/**
 * Whether `leafData` sits at `index` of a tree of `treeSize` leaves with
 * `root`, per RFC 9162 section 2.1.3.2. Untrusted input: anything malformed
 * is a false, never a throw.
 */
export function verifyAuditPath(
    leafData: Uint8Array,
    index: number,
    treeSize: number,
    path: HashInput[],
    expectedRoot: HashInput,
): boolean {
    if (!(leafData instanceof Uint8Array)) return false
    if (!Number.isSafeInteger(treeSize) || !Number.isSafeInteger(index)) return false
    if (index < 0 || index >= treeSize) return false
    if (!Array.isArray(path)) return false

    let siblings: Uint8Array[]
    let rootBytes: Uint8Array
    try {
        siblings = path.map(p => (typeof p === "string" ? fromHex(p) : p))
        rootBytes = typeof expectedRoot === "string" ? fromHex(expectedRoot) : expectedRoot
    } catch {
        return false
    }
    if (!(rootBytes instanceof Uint8Array) || rootBytes.length !== 32) return false

    // Bit arithmetic on plain numbers: indices stay below 2^53, so divide
    // rather than use 32-bit shifts.
    let fn = index
    let sn = treeSize - 1
    let r = leafHash(leafData)
    for (const p of siblings) {
        if (!(p instanceof Uint8Array) || p.length !== 32) return false
        if (sn === 0) return false
        if (fn % 2 === 1 || fn === sn) {
            r = nodeHash(p, r)
            if (fn % 2 === 0) {
                while (fn % 2 === 0 && fn !== 0) {
                    fn = Math.floor(fn / 2)
                    sn = Math.floor(sn / 2)
                }
            }
        } else {
            r = nodeHash(r, p)
        }
        fn = Math.floor(fn / 2)
        sn = Math.floor(sn / 2)
    }
    return sn === 0 && bytesEqual(r, rootBytes)
}

export { toHex, fromHex }
