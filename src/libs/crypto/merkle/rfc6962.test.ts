import { describe, expect, it } from "bun:test"
import { sha256 } from "@noble/hashes/sha2.js"
import { EMPTY_ROOT, auditPath, fromHex, leafHash, nodeHash, root, toHex, verifyAuditPath } from "./rfc6962"

// Reference vectors from the Certificate Transparency implementation,
// cpp/merkletree/merkle_tree_test.cc (kInputs, kSHA256Roots, kSHA256Paths).
// The CT file numbers leaves from 1; the indices below are 0-based.
const EMPTY_TREE_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

const INPUTS = [
    "",
    "00",
    "10",
    "2021",
    "3031",
    "40414243",
    "5051525354555657",
    "606162636465666768696a6b6c6d6e6f",
]

// ROOTS[i] is the root of the tree over INPUTS[0..i].
const ROOTS = [
    "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
    "fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125",
    "aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77",
    "d37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7",
    "4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4",
    "76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef",
    "ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c",
    "5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328",
]

const PATHS: { index: number; treeSize: number; path: string[] }[] = [
    { index: 0, treeSize: 1, path: [] },
    {
        index: 0,
        treeSize: 8,
        path: [
            "96a296d224f285c67bee93c30f8a309157f0daa35dc5b87e410b78630a09cfc7",
            "5f083f0a1a33ca076a95279832580db3e0ef4584bdff1f54c8a360f50de3031e",
            "6b47aaf29ee3c2af9af889bc1fb9254dabd31177f16232dd6aab035ca39bf6e4",
        ],
    },
    {
        index: 5,
        treeSize: 8,
        path: [
            "bc1a0643b12e4d2d7c77918f44e0f4f79a838b6cf9ec5b5c283e1f4d88599e6b",
            "ca854ea128ed050b41b35ffc1b87b8eb2bde461e9e3b5596ece6b9d5975a0ae0",
            "d37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7",
        ],
    },
    {
        index: 2,
        treeSize: 3,
        path: ["fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125"],
    },
    {
        index: 1,
        treeSize: 5,
        path: [
            "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
            "5f083f0a1a33ca076a95279832580db3e0ef4584bdff1f54c8a360f50de3031e",
            "bc1a0643b12e4d2d7c77918f44e0f4f79a838b6cf9ec5b5c283e1f4d88599e6b",
        ],
    },
]

const inputs = INPUTS.map(fromHex)

function leavesOf(n: number): Uint8Array[] {
    return Array.from({ length: n }, (_, i) => new TextEncoder().encode(`leaf-${i}`))
}

function flipBit(bytes: Uint8Array, bit = 0): Uint8Array {
    const copy = new Uint8Array(bytes)
    copy[bit >> 3] ^= 1 << (bit & 7)
    return copy
}

describe("rfc6962 against the Certificate Transparency vectors", () => {
    it("hashes the empty tree to sha256 of the empty string", () => {
        expect(toHex(EMPTY_ROOT)).toBe(EMPTY_TREE_HASH)
        expect(toHex(root([]))).toBe(EMPTY_TREE_HASH)
        expect(toHex(sha256(new Uint8Array(0)))).toBe(EMPTY_TREE_HASH)
    })

    it("reproduces every incremental root", () => {
        for (let n = 1; n <= 8; n++) {
            expect(toHex(root(inputs.slice(0, n)))).toBe(ROOTS[n - 1])
        }
    })

    it("reproduces the reference audit paths, and they verify", () => {
        for (const { index, treeSize, path } of PATHS) {
            const tree = inputs.slice(0, treeSize)
            expect(auditPath(tree, index).map(toHex)).toEqual(path)
            expect(verifyAuditPath(inputs[index], index, treeSize, path, ROOTS[treeSize - 1])).toBe(true)
        }
    })

    it("uses the 0x00 leaf and 0x01 node prefixes", () => {
        expect(toHex(leafHash(inputs[0]))).toBe(ROOTS[0])
        expect(toHex(nodeHash(leafHash(inputs[0]), leafHash(inputs[1])))).toBe(ROOTS[1])
    })
})

describe("rfc6962 round trips", () => {
    it("verifies every index of every tree size from 1 to 17", () => {
        for (let n = 1; n <= 17; n++) {
            const leaves = leavesOf(n)
            const r = root(leaves)
            for (let i = 0; i < n; i++) {
                const path = auditPath(leaves, i)
                expect(path.length).toBeLessThanOrEqual(Math.ceil(Math.log2(n)))
                expect(verifyAuditPath(leaves[i], i, n, path, r)).toBe(true)
                expect(verifyAuditPath(leaves[i], i, n, path.map(toHex), toHex(r))).toBe(true)
            }
        }
    })

    it("refuses an index outside the tree when building a path", () => {
        expect(() => auditPath(leavesOf(3), 3)).toThrow(RangeError)
        expect(() => auditPath(leavesOf(3), -1)).toThrow(RangeError)
        expect(() => auditPath([], 0)).toThrow(RangeError)
    })
})

describe("rfc6962 tamper cases", () => {
    const n = 11
    const leaves = leavesOf(n)
    const r = root(leaves)

    it("rejects a changed leaf, sibling or root", () => {
        for (let i = 0; i < n; i++) {
            const path = auditPath(leaves, i)
            expect(verifyAuditPath(flipBit(leaves[i]), i, n, path, r)).toBe(false)
            for (let j = 0; j < path.length; j++) {
                const bad = path.slice()
                bad[j] = flipBit(bad[j], 255)
                expect(verifyAuditPath(leaves[i], i, n, bad, r)).toBe(false)
            }
            expect(verifyAuditPath(leaves[i], i, n, path, flipBit(r, 7))).toBe(false)
        }
    })

    it("rejects the right leaf at the wrong index", () => {
        for (let i = 0; i < n; i++) {
            const path = auditPath(leaves, i)
            for (let j = 0; j < n; j++) {
                if (j !== i) expect(verifyAuditPath(leaves[i], j, n, path, r)).toBe(false)
            }
        }
    })

    it("rejects a tree size that changes the path's shape", () => {
        for (let i = 0; i < n; i++) {
            const path = auditPath(leaves, i)
            for (const size of [2 * n, 4 * n]) {
                expect(verifyAuditPath(leaves[i], i, size, path, r)).toBe(false)
            }
        }
        // Leaf 10 of 11 has two siblings; in a tree of 10 it would be out of range,
        // and in one of 9 or fewer the index check refuses it.
        expect(verifyAuditPath(leaves[10], 10, 10, auditPath(leaves, 10), r)).toBe(false)
    })

    it("does not bind the tree size, so callers must take it from signed data", () => {
        // RFC 6962 roots do not commit to n: a size whose path has the same
        // shape verifies too. Clients read the size from the signed block
        // (its ordered transaction count), never from the proof.
        const path = auditPath(leaves, 0)
        expect(verifyAuditPath(leaves[0], 0, 12, path, r)).toBe(true)
    })

    it("rejects a truncated, extended or reordered path", () => {
        const path = auditPath(leaves, 6)
        expect(verifyAuditPath(leaves[6], 6, n, path.slice(0, -1), r)).toBe(false)
        expect(verifyAuditPath(leaves[6], 6, n, [...path, path[0]], r)).toBe(false)
        expect(verifyAuditPath(leaves[6], 6, n, path.slice().reverse(), r)).toBe(false)
    })

    it("rejects an inner node presented as a leaf", () => {
        const two = leavesOf(2)
        const twoRoot = root(two)
        const forged = new Uint8Array([...leafHash(two[0]), ...leafHash(two[1])])
        expect(verifyAuditPath(forged, 0, 1, [], twoRoot)).toBe(false)
    })

    it("returns false on malformed input instead of throwing", () => {
        const path = auditPath(leaves, 0)
        expect(verifyAuditPath(leaves[0], 0, n, path, "0x" + toHex(r))).toBe(false)
        expect(verifyAuditPath(leaves[0], 0, n, path, toHex(r).toUpperCase())).toBe(false)
        expect(verifyAuditPath(leaves[0], 0, n, [toHex(path[0]).slice(2), ...path.slice(1)], r)).toBe(false)
        expect(verifyAuditPath(leaves[0], 0, n, [path[0].slice(1), ...path.slice(1)], r)).toBe(false)
        expect(verifyAuditPath(leaves[0], -1, n, path, r)).toBe(false)
        expect(verifyAuditPath(leaves[0], 0, 0, [], EMPTY_ROOT)).toBe(false)
        expect(verifyAuditPath(leaves[0], 0.5, n, path, r)).toBe(false)
        expect(verifyAuditPath(leaves[0], 0, n, path, r.slice(1))).toBe(false)
    })
})
