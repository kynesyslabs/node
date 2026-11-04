import { describe, expect, it } from "bun:test"
import { sha256 } from "@noble/hashes/sha2.js"
import { fromHex, toHex } from "./hex"
import {
    EMPTY_SUBTREE,
    SparseMerkleTree,
    sparseLeafHash,
    sparseRoot,
    verifyMembership,
    verifyNonMembership,
    type SparseEntry,
    type SparseProof,
} from "./sparse"

const enc = new TextEncoder()
const h = (label: string): Uint8Array => sha256(enc.encode(label))
const node = (l: Uint8Array, r: Uint8Array): Uint8Array =>
    sha256(new Uint8Array([0x01, ...l, ...r]))

function entries(n: number, tag = "k"): { key: Uint8Array; valueHash: Uint8Array }[] {
    return Array.from({ length: n }, (_, i) => ({ key: h(`${tag}-${i}`), valueHash: h(`v-${tag}-${i}`) }))
}

// Deterministic shuffle so a failure reproduces.
function shuffled<T>(items: T[], seed: string): T[] {
    const out = items.slice()
    for (let i = out.length - 1; i > 0; i--) {
        const r = h(`${seed}-${i}`)
        const j = ((r[0] << 16) | (r[1] << 8) | r[2]) % (i + 1)
        ;[out[i], out[j]] = [out[j], out[i]]
    }
    return out
}

function flipHex(hex: string, nibble = 0): string {
    const c = parseInt(hex[nibble], 16) ^ 1
    return hex.slice(0, nibble) + c.toString(16) + hex.slice(nibble + 1)
}

/** A key with the given leading bits, the rest from `fill`. */
function keyWithPrefix(bits: number[], fill: Uint8Array): Uint8Array {
    const key = new Uint8Array(fill)
    bits.forEach((bit, d) => {
        const mask = 1 << (7 - (d & 7))
        key[d >> 3] = bit ? key[d >> 3] | mask : key[d >> 3] & ~mask
    })
    return key
}

describe("sparse Merkle tree hashing rules", () => {
    it("hashes the empty tree to 32 zero bytes, and proves any key absent", () => {
        const tree = SparseMerkleTree.build([])
        expect(tree.rootHex).toBe("0".repeat(64))
        expect(tree.root).toEqual(EMPTY_SUBTREE)
        const proof = tree.prove(h("anything"))
        expect(proof).toEqual({ siblings: [], terminal: { kind: "empty" } })
        expect(verifyNonMembership(h("anything"), proof, tree.root)).toBe(true)
    })

    it("hashes a single leaf at the root as sha256(0x02 || key || valueHash)", () => {
        const key = h("only")
        const valueHash = h("value")
        const expected = sha256(new Uint8Array([0x02, ...key, ...valueHash]))
        expect(sparseLeafHash(key, valueHash)).toEqual(expected)
        expect(sparseRoot([{ key, valueHash }])).toEqual(expected)
    })

    it("splits on the most significant bit first and compresses single leaves", () => {
        const fill = h("fill")
        // Both keys start 00000 and part at bit 5: five inner nodes with an
        // empty right subtree above the split, and two leaves below it.
        const a = keyWithPrefix([0, 0, 0, 0, 0, 0], fill)
        const b = keyWithPrefix([0, 0, 0, 0, 0, 1], fill)
        const va = h("va")
        const vb = h("vb")
        let expected = node(sparseLeafHash(a, va), sparseLeafHash(b, vb))
        for (let d = 0; d < 5; d++) expected = node(expected, EMPTY_SUBTREE)
        expect(sparseRoot([{ key: b, valueHash: vb }, { key: a, valueHash: va }])).toEqual(expected)

        // A third key on the other side of bit 0 stays a compressed leaf.
        const c = keyWithPrefix([1], fill)
        const vc = h("vc")
        let left = node(sparseLeafHash(a, va), sparseLeafHash(b, vb))
        for (let d = 1; d < 5; d++) left = node(left, EMPTY_SUBTREE)
        expect(
            sparseRoot([
                { key: a, valueHash: va },
                { key: c, valueHash: vc },
                { key: b, valueHash: vb },
            ]),
        ).toEqual(node(left, sparseLeafHash(c, vc)))
    })

    it("handles keys that differ only in the last bit", () => {
        const fill = new Uint8Array(32).fill(0xab)
        const a = new Uint8Array(fill)
        const b = new Uint8Array(fill)
        a[31] &= 0xfe
        b[31] |= 0x01
        const tree = SparseMerkleTree.build([
            { key: a, valueHash: h("a") },
            { key: b, valueHash: h("b") },
        ])
        const proof = tree.prove(b)
        expect(proof.siblings.length).toBe(256)
        expect(verifyMembership(b, h("b"), proof, tree.root)).toBe(true)
        expect(verifyMembership(a, h("a"), tree.prove(a), tree.root)).toBe(true)
    })

    it("refuses duplicate keys and wrong-length inputs", () => {
        const [e] = entries(1)
        expect(() => SparseMerkleTree.build([e, { key: e.key, valueHash: h("other") }])).toThrow(/duplicate/)
        expect(() => SparseMerkleTree.build([e, { key: toHex(e.key), valueHash: e.valueHash }])).toThrow(
            /duplicate/,
        )
        expect(() => SparseMerkleTree.build([{ key: e.key.slice(1), valueHash: e.valueHash }])).toThrow()
        expect(() => SparseMerkleTree.build([{ key: e.key, valueHash: new Uint8Array(33) }])).toThrow()
        expect(() => SparseMerkleTree.build([{ key: "0x" + toHex(e.key), valueHash: e.valueHash }])).toThrow()
    })
})

describe("sparse Merkle tree over random sets", () => {
    for (const n of [1, 2, 3, 7, 64, 500]) {
        it(`is order-independent and proves every member of a set of ${n}`, () => {
            const set = entries(n, `set${n}`)
            const tree = SparseMerkleTree.build(set)
            for (let s = 0; s < 3; s++) {
                expect(SparseMerkleTree.build(shuffled(set, `${n}-${s}`)).rootHex).toBe(tree.rootHex)
            }
            const asHex: SparseEntry[] = set.map(e => ({ key: toHex(e.key), valueHash: toHex(e.valueHash) }))
            expect(sparseRoot(asHex)).toEqual(tree.root)

            for (const e of set) {
                const proof = tree.prove(e.key)
                expect(proof.terminal).toEqual({
                    kind: "leaf",
                    key: toHex(e.key),
                    valueHash: toHex(e.valueHash),
                })
                expect(verifyMembership(e.key, e.valueHash, proof, tree.root)).toBe(true)
                expect(verifyMembership(toHex(e.key), toHex(e.valueHash), proof, tree.rootHex)).toBe(true)
                expect(verifyNonMembership(e.key, proof, tree.root)).toBe(false)
            }
        })
    }

    it("proves absent keys through both an empty subtree and a foreign leaf", () => {
        const set = entries(300, "abs")
        const tree = SparseMerkleTree.build(set)
        const seen = { empty: 0, leaf: 0 }
        for (let i = 0; i < 2_000; i++) {
            const key = h(`absent-${i}`)
            const proof = tree.prove(key)
            seen[proof.terminal.kind]++
            expect(verifyNonMembership(key, proof, tree.root)).toBe(true)
            expect(verifyMembership(key, h("any"), proof, tree.root)).toBe(false)
        }
        expect(seen.empty).toBeGreaterThan(0)
        expect(seen.leaf).toBeGreaterThan(0)
    })

    it("changes the root when a value changes, a key is added or one is removed", () => {
        const set = entries(50, "chg")
        const base = SparseMerkleTree.build(set).rootHex
        const changed = set.map((e, i) => (i === 17 ? { ...e, valueHash: h("new") } : e))
        expect(SparseMerkleTree.build(changed).rootHex).not.toBe(base)
        expect(SparseMerkleTree.build([...set, { key: h("extra"), valueHash: h("x") }]).rootHex).not.toBe(base)
        expect(SparseMerkleTree.build(set.slice(1)).rootHex).not.toBe(base)
    })
})

describe("sparse Merkle proof tamper cases", () => {
    const set = entries(200, "tamper")
    const tree = SparseMerkleTree.build(set)
    const member = set[42]
    const memberProof = tree.prove(member.key)
    const findAbsent = (kind: "empty" | "leaf"): { key: Uint8Array; proof: SparseProof } => {
        for (let i = 0; ; i++) {
            const key = h(`t-absent-${i}`)
            const proof = tree.prove(key)
            if (proof.terminal.kind === kind) return { key, proof }
        }
    }
    const viaEmpty = findAbsent("empty")
    const viaLeaf = findAbsent("leaf")

    it("rejects a wrong value, a wrong key or a wrong root", () => {
        expect(verifyMembership(member.key, h("wrong"), memberProof, tree.root)).toBe(false)
        expect(verifyMembership(set[43].key, member.valueHash, memberProof, tree.root)).toBe(false)
        expect(verifyMembership(member.key, member.valueHash, memberProof, flipHex(tree.rootHex))).toBe(false)
        expect(verifyNonMembership(viaEmpty.key, viaEmpty.proof, flipHex(tree.rootHex, 63))).toBe(false)
    })

    it("rejects a changed, dropped, added or reordered sibling", () => {
        for (const p of [memberProof, viaEmpty.proof, viaLeaf.proof]) {
            const key = p === memberProof ? member.key : p === viaEmpty.proof ? viaEmpty.key : viaLeaf.key
            const check = (proof: SparseProof) =>
                p === memberProof
                    ? verifyMembership(key, member.valueHash, proof, tree.root)
                    : verifyNonMembership(key, proof, tree.root)
            expect(check(p)).toBe(true)
            expect(p.siblings.length).toBeGreaterThan(1)
            for (let i = 0; i < p.siblings.length; i++) {
                const siblings = p.siblings.slice()
                siblings[i] = flipHex(siblings[i], 10)
                expect(check({ ...p, siblings })).toBe(false)
            }
            expect(check({ ...p, siblings: p.siblings.slice(1) })).toBe(false)
            expect(check({ ...p, siblings: p.siblings.slice(0, -1) })).toBe(false)
            expect(check({ ...p, siblings: [...p.siblings, "0".repeat(64)] })).toBe(false)
            expect(check({ ...p, siblings: ["0".repeat(64), ...p.siblings] })).toBe(false)
            expect(check({ ...p, siblings: p.siblings.slice().reverse() })).toBe(false)
        }
    })

    it("cannot prove a present key absent", () => {
        expect(verifyNonMembership(member.key, memberProof, tree.root)).toBe(false)
        expect(
            verifyNonMembership(member.key, { siblings: memberProof.siblings, terminal: { kind: "empty" } }, tree.root),
        ).toBe(false)
        // Another member's leaf presented at the end of this key's path.
        const other = tree.prove(set[43].key)
        expect(verifyNonMembership(member.key, { ...memberProof, terminal: other.terminal }, tree.root)).toBe(false)
    })

    it("cannot prove an absent key present", () => {
        expect(verifyMembership(viaEmpty.key, h("x"), viaEmpty.proof, tree.root)).toBe(false)
        const forged: SparseProof = {
            siblings: viaLeaf.proof.siblings,
            terminal: { kind: "leaf", key: toHex(viaLeaf.key), valueHash: toHex(h("x")) },
        }
        expect(verifyMembership(viaLeaf.key, h("x"), forged, tree.root)).toBe(false)
    })

    it("rejects a foreign leaf that is not on the key's path", () => {
        if (viaLeaf.proof.terminal.kind !== "leaf") throw new Error("unreachable")
        const foreign = fromHex(viaLeaf.proof.terminal.key)
        // Same leaf, but claimed for a key that leaves its prefix at bit 0.
        const elsewhere = new Uint8Array(viaLeaf.key)
        elsewhere[0] ^= 0x80
        expect(verifyNonMembership(elsewhere, viaLeaf.proof, tree.root)).toBe(false)
        expect(viaLeaf.proof.terminal.key).toBe(toHex(foreign))
    })

    it("rejects the wrong terminal kind and malformed proofs without throwing", () => {
        expect(verifyNonMembership(viaLeaf.key, { ...viaLeaf.proof, terminal: { kind: "empty" } }, tree.root)).toBe(
            false,
        )
        expect(verifyNonMembership(viaEmpty.key, { ...viaEmpty.proof, terminal: memberProof.terminal }, tree.root)).toBe(
            false,
        )
        const bad: unknown[] = [
            null,
            {},
            { siblings: "x", terminal: { kind: "empty" } },
            { siblings: [], terminal: { kind: "other" } },
            { siblings: [1], terminal: { kind: "empty" } },
            { siblings: viaEmpty.proof.siblings.map(s => s.toUpperCase()), terminal: { kind: "empty" } },
            { siblings: viaEmpty.proof.siblings.map(s => "0x" + s), terminal: { kind: "empty" } },
            { siblings: viaEmpty.proof.siblings.map(s => s.slice(2)), terminal: { kind: "empty" } },
            { siblings: Array(257).fill("0".repeat(64)), terminal: { kind: "empty" } },
            { siblings: [], terminal: { kind: "leaf", key: 5, valueHash: "00" } },
        ]
        for (const proof of bad) {
            expect(verifyNonMembership(viaEmpty.key, proof as SparseProof, tree.root)).toBe(false)
            expect(verifyMembership(member.key, member.valueHash, proof as SparseProof, tree.root)).toBe(false)
        }
        expect(verifyMembership(member.key.slice(1), member.valueHash, memberProof, tree.root)).toBe(false)
        expect(verifyNonMembership(viaEmpty.key, viaEmpty.proof, tree.root.slice(1))).toBe(false)
    })
})

describe("sparse Merkle tree build cost", () => {
    it("builds 10^4 keys", () => {
        const set = entries(10_000, "bench")
        const started = performance.now()
        const tree = SparseMerkleTree.build(set)
        const ms = performance.now() - started
        // eslint-disable-next-line no-console
        console.log(`sparse: built 10^4 keys in ${ms.toFixed(1)} ms, root ${tree.rootHex.slice(0, 16)}...`)
        expect(tree.size).toBe(10_000)
        // Loose bound: catches an accidental quadratic build, not a slow machine.
        expect(ms).toBeLessThan(10_000)
    })
})
