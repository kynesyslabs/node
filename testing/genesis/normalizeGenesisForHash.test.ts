/**
 * Unit tests for src/libs/blockchain/genesis/normalizeGenesisForHash.ts
 *
 * Coverage:
 *  - connection_url stripped from each validator entry
 *  - validators sorted by address regardless of input order
 *  - stableStringify emits lex-sorted keys at every depth
 *  - two genesis-data objects differing only in connection_url and
 *    insertion order produce the same hash
 *  - empty / missing / non-array validators is tolerated
 *  - non-object input (null, primitive, array) is coerced safely
 *  - mutation safety: input object is not modified
 */

import { describe, it, expect } from "bun:test"
import {
    canonicalGenesisForHashing,
    stableStringify,
    hashGenesisData,
    hashGenesisCore,
} from "src/libs/blockchain/genesis/normalizeGenesisForHash"

const VALIDATORS_A = [
    {
        address: "0xb0000000000000000000000000000000000000000000000000000000000000bb",
        status: "2",
        connection_url: "http://localhost:53552",
        staked_amount: "1000000000000000000",
        first_seen: 0,
        valid_at: 0,
    },
    {
        address: "0xa0000000000000000000000000000000000000000000000000000000000000aa",
        status: "2",
        connection_url: "http://dev.node3.demos.sh:53550",
        staked_amount: "1000000000000000000",
        first_seen: 0,
        valid_at: 0,
    },
]

// Same validators as VALIDATORS_A but:
//   - reversed order
//   - different connection_url values (mimic the "other node's view")
const VALIDATORS_B = [
    {
        address: "0xa0000000000000000000000000000000000000000000000000000000000000aa",
        status: "2",
        connection_url: "http://localhost:53550",   // <- differs from A
        staked_amount: "1000000000000000000",
        first_seen: 0,
        valid_at: 0,
    },
    {
        address: "0xb0000000000000000000000000000000000000000000000000000000000000bb",
        status: "2",
        connection_url: "http://dev.node2.demos.sh:53552",  // <- differs from A
        staked_amount: "1000000000000000000",
        first_seen: 0,
        valid_at: 0,
    },
]

const GENESIS_BASE = {
    properties: { id: 1, name: "DEMOS", currency: "DEM" },
    mutables: { minBlocksForValidationOnlineStatus: 4 },
    forks: {
        osDenomination: { activationHeight: null },
        gasFeeSeparation: {
            activationHeight: null,
            treasuryAddress: "0x" + "f7".repeat(32),
        },
    },
    balances: [],
    timestamp: "1692734616",
    status: "confirmed",
}

describe("canonicalGenesisForHashing", () => {
    it("strips connection_url from every validator entry", () => {
        const canonical = canonicalGenesisForHashing({
            ...GENESIS_BASE,
            validators: VALIDATORS_A,
        })

        const vs = canonical.validators as Array<Record<string, unknown>>
        expect(vs).toHaveLength(2)
        for (const v of vs) {
            expect("connection_url" in v).toBe(false)
        }
    })

    it("sorts validators by address ascending", () => {
        const canonical = canonicalGenesisForHashing({
            ...GENESIS_BASE,
            validators: VALIDATORS_A, // input has bb first, then aa
        })

        const vs = canonical.validators as Array<Record<string, unknown>>
        expect(vs[0].address).toBe(
            "0xa0000000000000000000000000000000000000000000000000000000000000aa",
        )
        expect(vs[1].address).toBe(
            "0xb0000000000000000000000000000000000000000000000000000000000000bb",
        )
    })

    it("does not mutate the input object", () => {
        const input = {
            ...GENESIS_BASE,
            validators: VALIDATORS_A.map(v => ({ ...v })),
        }
        const snapshotBefore = JSON.parse(JSON.stringify(input))
        canonicalGenesisForHashing(input)
        expect(input).toEqual(snapshotBefore)
        // connection_url still on the originals
        expect(input.validators[0].connection_url).toBe(
            "http://localhost:53552",
        )
    })

    it("tolerates missing validators field (treated as empty)", () => {
        const canonical = canonicalGenesisForHashing(GENESIS_BASE)
        expect(canonical.validators).toBeUndefined()
    })

    it("tolerates non-array validators (skipped)", () => {
        const canonical = canonicalGenesisForHashing({
            ...GENESIS_BASE,
            validators: "not an array" as unknown,
        })
        expect(canonical.validators).toBeUndefined()
    })

    it("coerces null/primitive/array input to empty object", () => {
        expect(canonicalGenesisForHashing(null)).toEqual({})
        expect(canonicalGenesisForHashing(42)).toEqual({})
        expect(canonicalGenesisForHashing("foo")).toEqual({})
        expect(canonicalGenesisForHashing([])).toEqual({})
    })

    it("preserves non-validators top-level fields verbatim", () => {
        const canonical = canonicalGenesisForHashing({
            ...GENESIS_BASE,
            validators: VALIDATORS_A,
        })
        expect(canonical.properties).toEqual(GENESIS_BASE.properties)
        expect(canonical.mutables).toEqual(GENESIS_BASE.mutables)
        expect(canonical.forks).toEqual(GENESIS_BASE.forks)
        expect(canonical.balances).toEqual(GENESIS_BASE.balances)
        expect(canonical.timestamp).toEqual(GENESIS_BASE.timestamp)
        expect(canonical.status).toEqual(GENESIS_BASE.status)
    })
})

describe("stableStringify", () => {
    it("emits object keys in lexicographic order", () => {
        const out = stableStringify({ b: 2, a: 1, c: { y: 2, x: 1 } })
        expect(out).toBe('{"a":1,"b":2,"c":{"x":1,"y":2}}')
    })

    it("walks arrays element-wise", () => {
        const out = stableStringify([{ b: 2, a: 1 }, { d: 4, c: 3 }])
        expect(out).toBe('[{"a":1,"b":2},{"c":3,"d":4}]')
    })

    it("handles primitives and null", () => {
        expect(stableStringify(null)).toBe("null")
        expect(stableStringify(42)).toBe("42")
        expect(stableStringify("x")).toBe('"x"')
        expect(stableStringify(true)).toBe("true")
        expect(stableStringify(false)).toBe("false")
    })

    it("produces same output for differently-authored equivalent objects", () => {
        const a = stableStringify({ x: 1, y: { b: 2, a: 1 } })
        const b = stableStringify({ y: { a: 1, b: 2 }, x: 1 })
        expect(a).toBe(b)
    })
})

describe("hashGenesisData", () => {
    it("produces the same hash for two genesis objects differing only in connection_url + validator order", () => {
        const hashA = hashGenesisData({
            ...GENESIS_BASE,
            validators: VALIDATORS_A,
        })
        const hashB = hashGenesisData({
            ...GENESIS_BASE,
            validators: VALIDATORS_B,
        })
        expect(hashA).toBe(hashB)
    })

    it("produces a different hash when a consensus-significant field changes", () => {
        const baseline = hashGenesisData({
            ...GENESIS_BASE,
            validators: VALIDATORS_A,
        })

        // bumping staked_amount on a validator
        const tampered = hashGenesisData({
            ...GENESIS_BASE,
            validators: [
                { ...VALIDATORS_A[0], staked_amount: "999" },
                VALIDATORS_A[1],
            ],
        })
        expect(tampered).not.toBe(baseline)
    })

    it("produces a different hash when an unrelated top-level field changes", () => {
        const baseline = hashGenesisData({
            ...GENESIS_BASE,
            validators: VALIDATORS_A,
        })
        const tampered = hashGenesisData({
            ...GENESIS_BASE,
            validators: VALIDATORS_A,
            properties: { ...GENESIS_BASE.properties, currency: "OS" },
        })
        expect(tampered).not.toBe(baseline)
    })

    it("is deterministic across repeated calls", () => {
        const h1 = hashGenesisData({
            ...GENESIS_BASE,
            validators: VALIDATORS_A,
        })
        const h2 = hashGenesisData({
            ...GENESIS_BASE,
            validators: VALIDATORS_A,
        })
        expect(h1).toBe(h2)
    })

    it("emits a hex-encoded sha256 (64 lowercase hex chars)", () => {
        const h = hashGenesisData({
            ...GENESIS_BASE,
            validators: VALIDATORS_A,
        })
        expect(h).toMatch(/^[0-9a-f]{64}$/)
    })
})

describe("hashGenesisCore", () => {
    it("ignores the fork schedule and the chain id", () => {
        const edited = {
            ...GENESIS_BASE,
            properties: { ...GENESIS_BASE.properties, id: 31337 },
            forks: {
                ...GENESIS_BASE.forks,
                signatureDomain: { activationHeight: 40 },
            },
            validators: VALIDATORS_A,
        }
        expect(hashGenesisCore(edited)).toBe(
            hashGenesisCore({ ...GENESIS_BASE, validators: VALIDATORS_A }),
        )
    })

    it("ignores a missing chain id", () => {
        const { id: _id, ...withoutId } = GENESIS_BASE.properties
        expect(
            hashGenesisCore({ ...GENESIS_BASE, properties: withoutId }),
        ).toBe(hashGenesisCore(GENESIS_BASE))
    })

    it("still tells apart anything else in properties, balances and validators", () => {
        const base = hashGenesisCore(GENESIS_BASE)
        expect(
            hashGenesisCore({
                ...GENESIS_BASE,
                properties: { ...GENESIS_BASE.properties, name: "OTHER" },
            }),
        ).not.toBe(base)
        expect(
            hashGenesisCore({ ...GENESIS_BASE, balances: [["0xab", "1"]] }),
        ).not.toBe(base)
        expect(
            hashGenesisCore({ ...GENESIS_BASE, validators: VALIDATORS_A }),
        ).not.toBe(base)
    })

    it("tolerates properties that are not an object", () => {
        expect(() =>
            hashGenesisCore({ ...GENESIS_BASE, properties: "oops" }),
        ).not.toThrow()
    })
})

describe("hashGenesisData stays the full hash peers advertise", () => {
    it("changes when the fork schedule or the chain id changes", () => {
        const base = hashGenesisData(GENESIS_BASE)
        expect(
            hashGenesisData({
                ...GENESIS_BASE,
                forks: { ...GENESIS_BASE.forks, signatureDomain: { activationHeight: 40 } },
            }),
        ).not.toBe(base)
        expect(
            hashGenesisData({
                ...GENESIS_BASE,
                properties: { ...GENESIS_BASE.properties, id: 2 },
            }),
        ).not.toBe(base)
    })
})

describe("hashGenesisData golden vector", () => {
    // Every node already on the network advertises and compares this exact
    // value for the same data, so the normalisation must never change what it
    // produces: a different hash here would split a new build from the old ones.
    const FIXTURE = {
        timestamp: "1700000000",
        balances: [
            ["0xa0000000000000000000000000000000000000000000000000000000000000aa", "1000"],
            ["0xb0000000000000000000000000000000000000000000000000000000000000bb", "2000"],
        ],
        properties: { name: "golden", mutables: { rate: 5 } },
        validators: [
            {
                address: "0xb0000000000000000000000000000000000000000000000000000000000000bb",
                status: "2",
                connection_url: "http://localhost:53551",
                staked_amount: "1",
            },
            {
                address: "0xa0000000000000000000000000000000000000000000000000000000000000aa",
                status: "2",
                connection_url: "http://node-1:53551",
                staked_amount: "1",
            },
        ],
        forks: { signatureDomain: { activationHeight: 40 } },
    }

    it("is pinned", () => {
        expect(hashGenesisData(FIXTURE)).toBe("b24e72530d5fee6076cbb1017d5405f8844666fa67c0b601e1c8d9788de7bef6")
    })
})
