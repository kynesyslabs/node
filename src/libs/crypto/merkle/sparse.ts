/**
 * Compressed sparse Merkle tree over 256-bit keys (Jellyfish-style), SHA-256.
 *
 * The storage state root commits every program under its key, and a client
 * needs to prove both that a key holds a value and that a key is absent. A
 * plain sparse tree would take 256 hashes per proof; compressing every
 * single-leaf subtree into its leaf brings that down to about log2(n) while
 * keeping the root a pure function of the set of (key, valueHash) pairs:
 *
 * - empty subtree: 32 zero bytes;
 * - subtree holding exactly one leaf: sha256(0x02 || key || valueHash), at
 *   whatever depth it sits;
 * - otherwise: sha256(0x01 || H(left) || H(right)), where left holds the keys
 *   whose bit d (most significant bit first) is 0.
 *
 * The 0x01 / 0x02 prefixes keep a leaf and an inner node from passing for one
 * another, and the leaf hash commits to the full key, so a leaf cannot be
 * moved to another position. Two distinct keys differ at some bit below 256,
 * which bounds the depth.
 */

import { sha256 } from "@noble/hashes/sha2.js"
import { bytesEqual, fromHex, hash32, toHex, type HashInput } from "./hex"

const NODE_PREFIX = Uint8Array.of(0x01)
const LEAF_PREFIX = Uint8Array.of(0x02)
const KEY_BITS = 256

/** Hash of an empty subtree. */
export const EMPTY_SUBTREE: Uint8Array = new Uint8Array(32)

export interface SparseEntry {
    key: HashInput
    valueHash: HashInput
}

export type SparseTerminal =
    | { kind: "leaf"; key: string; valueHash: string }
    | { kind: "empty" }

/** Siblings run from the root downward; the terminal ends the key's path. */
export interface SparseProof {
    siblings: string[]
    terminal: SparseTerminal
}

export function sparseLeafHash(key: Uint8Array, valueHash: Uint8Array): Uint8Array {
    return sha256.create().update(LEAF_PREFIX).update(key).update(valueHash).digest()
}

function sparseNodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
    return sha256.create().update(NODE_PREFIX).update(left).update(right).digest()
}

function bitAt(key: Uint8Array, depth: number): number {
    return (key[depth >> 3] >> (7 - (depth & 7))) & 1
}

interface Leaf {
    key: Uint8Array
    valueHash: Uint8Array
    keyHex: string
}

type Node =
    | { kind: "leaf"; hash: Uint8Array; leaf: Leaf }
    | { kind: "inner"; hash: Uint8Array; left: Node | null; right: Node | null }

const hashOf = (node: Node | null): Uint8Array => (node ? node.hash : EMPTY_SUBTREE)

/** `leaves[lo..hi)` are sorted and share their first `depth` bits. */
function buildNode(leaves: Leaf[], lo: number, hi: number, depth: number): Node | null {
    if (hi === lo) return null
    if (hi - lo === 1) {
        const leaf = leaves[lo]
        return { kind: "leaf", hash: sparseLeafHash(leaf.key, leaf.valueHash), leaf }
    }
    // Sorted keys with a common prefix put every 0 at bit `depth` first.
    let a = lo
    let b = hi
    while (a < b) {
        const mid = (a + b) >>> 1
        if (bitAt(leaves[mid].key, depth) === 0) a = mid + 1
        else b = mid
    }
    const left = buildNode(leaves, lo, a, depth + 1)
    const right = buildNode(leaves, a, hi, depth + 1)
    return { kind: "inner", hash: sparseNodeHash(hashOf(left), hashOf(right)), left, right }
}

export class SparseMerkleTree {
    private constructor(
        private readonly top: Node | null,
        readonly size: number,
    ) {}

    /**
     * Builds the tree of `entries`. The result depends only on the set of
     * pairs, not their order; a key given twice is refused rather than one
     * value silently winning.
     */
    static build(entries: Iterable<SparseEntry>): SparseMerkleTree {
        const leaves: Leaf[] = []
        for (const entry of entries) {
            const key = hash32(entry.key, "key")
            const valueHash = hash32(entry.valueHash, "valueHash")
            leaves.push({ key, valueHash, keyHex: toHex(key) })
        }
        // Lowercase hex of equal length sorts like the bytes it spells.
        leaves.sort((x, y) => (x.keyHex < y.keyHex ? -1 : x.keyHex > y.keyHex ? 1 : 0))
        for (let i = 1; i < leaves.length; i++) {
            if (leaves[i].keyHex === leaves[i - 1].keyHex) {
                throw new Error(`sparse: duplicate key ${leaves[i].keyHex}`)
            }
        }
        return new SparseMerkleTree(buildNode(leaves, 0, leaves.length, 0), leaves.length)
    }

    get root(): Uint8Array {
        return hashOf(this.top)
    }

    get rootHex(): string {
        return toHex(this.root)
    }

    /** Proof for `key`: membership when it is present, non-membership otherwise. */
    prove(keyInput: HashInput): SparseProof {
        const key = hash32(keyInput, "key")
        const siblings: string[] = []
        let node = this.top
        let depth = 0
        while (node && node.kind === "inner") {
            const right = bitAt(key, depth) === 1
            siblings.push(toHex(hashOf(right ? node.left : node.right)))
            node = right ? node.right : node.left
            depth++
        }
        if (!node || node.kind !== "leaf") return { siblings, terminal: { kind: "empty" } }
        return {
            siblings,
            terminal: {
                kind: "leaf",
                key: node.leaf.keyHex,
                valueHash: toHex(node.leaf.valueHash),
            },
        }
    }
}

/** Root of the tree over `entries`, without keeping the tree. */
export function sparseRoot(entries: Iterable<SparseEntry>): Uint8Array {
    return SparseMerkleTree.build(entries).root
}

function sharesPrefix(a: Uint8Array, b: Uint8Array, bits: number): boolean {
    for (let d = 0; d < bits; d++) if (bitAt(a, d) !== bitAt(b, d)) return false
    return true
}

/**
 * Folds the proof up along `key`'s path from `terminalHash`. Null when the
 * proof is malformed; untrusted input never throws.
 */
function rootAlongPath(key: Uint8Array, terminalHash: Uint8Array, siblings: unknown): Uint8Array | null {
    if (!Array.isArray(siblings) || siblings.length > KEY_BITS) return null
    const parsed: Uint8Array[] = []
    for (const s of siblings) {
        if (typeof s !== "string") return null
        const bytes = fromHex(s)
        if (bytes.length !== 32) return null
        parsed.push(bytes)
    }
    let h = terminalHash
    for (let d = parsed.length - 1; d >= 0; d--) {
        h = bitAt(key, d) === 1 ? sparseNodeHash(parsed[d], h) : sparseNodeHash(h, parsed[d])
    }
    return h
}

function readTerminalLeaf(terminal: SparseTerminal): { key: Uint8Array; valueHash: Uint8Array } {
    const t = terminal as { key?: unknown; valueHash?: unknown }
    if (typeof t.key !== "string" || typeof t.valueHash !== "string") {
        throw new Error("sparse: malformed leaf terminal")
    }
    return { key: hash32(t.key, "terminal key"), valueHash: hash32(t.valueHash, "terminal valueHash") }
}

/** Whether `root` holds `valueHash` under `key`. */
export function verifyMembership(
    keyInput: HashInput,
    valueHashInput: HashInput,
    proof: SparseProof,
    rootInput: HashInput,
): boolean {
    try {
        const key = hash32(keyInput, "key")
        const valueHash = hash32(valueHashInput, "valueHash")
        const root = hash32(rootInput, "root")
        if (proof?.terminal?.kind !== "leaf") return false
        const leaf = readTerminalLeaf(proof.terminal)
        if (!bytesEqual(leaf.key, key) || !bytesEqual(leaf.valueHash, valueHash)) return false
        const computed = rootAlongPath(key, sparseLeafHash(leaf.key, leaf.valueHash), proof.siblings)
        return computed !== null && bytesEqual(computed, root)
    } catch {
        return false
    }
}

/**
 * Whether `root` holds nothing under `key`: its path ends in an empty
 * subtree, or in the single leaf of another key that shares every bit of
 * `key`'s path so far.
 */
export function verifyNonMembership(keyInput: HashInput, proof: SparseProof, rootInput: HashInput): boolean {
    try {
        const key = hash32(keyInput, "key")
        const root = hash32(rootInput, "root")
        const terminal = proof?.terminal
        let terminalHash: Uint8Array
        if (terminal?.kind === "empty") {
            terminalHash = EMPTY_SUBTREE
        } else if (terminal?.kind === "leaf") {
            const leaf = readTerminalLeaf(terminal)
            if (bytesEqual(leaf.key, key)) return false
            if (!Array.isArray(proof.siblings)) return false
            if (!sharesPrefix(leaf.key, key, Math.min(proof.siblings.length, KEY_BITS))) return false
            terminalHash = sparseLeafHash(leaf.key, leaf.valueHash)
        } else {
            return false
        }
        const computed = rootAlongPath(key, terminalHash, proof.siblings)
        return computed !== null && bytesEqual(computed, root)
    } catch {
        return false
    }
}
