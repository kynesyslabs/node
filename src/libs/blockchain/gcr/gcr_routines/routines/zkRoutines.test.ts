import { describe, expect, it, mock } from "bun:test"

/**
 * A commitment's row is inserted in the block's database transaction, so a
 * provider or timestamp Postgres refuses there failed the block on every
 * node. Checked when the edit applies, it fails this transaction alone.
 */

let treeState: { leafCount: number } | null = null
const fakeDataSource = {
    getRepository: (entity: { name?: string }) => ({
        findOne: async () => (entity?.name === "MerkleTreeState" ? treeState : null),
    }),
}
const datasourceModule = () => ({
    __esModule: true,
    dataSource: fakeDataSource,
    default: { getInstance: async () => ({ getDataSource: () => fakeDataSource }) },
})
mock.module("src/model/datasource", datasourceModule)
mock.module("@/model/datasource", datasourceModule)
mock.module("@/utilities/logger", () => ({
    __esModule: true,
    default: { debug: () => {}, info: () => {}, warn: () => {}, warning: () => {}, error: () => {}, only: () => {} },
}))

const { applyZkCommitmentAdd } = await import("./zkRoutines")

const edit = (payload: Record<string, unknown>) => ({
    type: "identity",
    operation: "zk_commitmentadd",
    txhash: "aa".repeat(32),
    data: { commitment_hash: "1" + "c".repeat(63), provider: "github", timestamp: 1_760_000_000_000, ...payload },
})

const BN254 = "21888242871839275222246405745257275088548364400416034343698204186575808495617"

const caches = (): any => ({ accounts: new Map(), zkCommitments: new Map() })

describe("applyZkCommitmentAdd", () => {
    it("stages the row of a clean commitment", async () => {
        const result = await applyZkCommitmentAdd(edit({}), false, caches())
        expect(result.success).toBe(true)
        expect(result.deferredWrite).toBeDefined()
    })

    it("takes a field element as the SDK writes it, in canonical decimal", async () => {
        for (const commitment_hash of ["0", "42", (BigInt(BN254) - 1n).toString(), "0x" + "0".repeat(63) + "1"]) {
            const result = await applyZkCommitmentAdd(edit({ commitment_hash }), false, caches())
            expect(`${commitment_hash} ${result.success}`).toBe(`${commitment_hash} true`)
        }
    })

    for (const [name, payload] of [
        ["U+0000 in the provider, a text column", { provider: "git\u0000hub" }],
        ["a fractional timestamp, which bigint refuses", { timestamp: 1.5 }],
        ["a timestamp beyond bigint", { timestamp: 1e20 }],
        // A primary key and an index: a b-tree entry over 2704 bytes fails the insert.
        ["a commitment of 3000 digits", { commitment_hash: "1" + "7".repeat(2999) }],
        ["a commitment with leading zeros, a second key for one leaf", { commitment_hash: "0042" }],
        ["a commitment at the field order", { commitment_hash: BN254 }],
        ["64 hex digits beyond the field order", { commitment_hash: "f".repeat(64) }],
        ["a provider too long for its index", { provider: "p".repeat(65) }],
    ] as const) {
        it(`fails the transaction, staging nothing: ${name}`, async () => {
            const entities = caches()
            const result = await applyZkCommitmentAdd(edit(payload), false, entities)
            expect(result.success).toBe(false)
            expect(result.deferredWrite).toBeUndefined()
            expect(entities.zkCommitments.size).toBe(0)
        })
    }
})

/**
 * The block commit inserts each commitment into the global tree, which throws
 * past its capacity: inside the block's transaction, that failed the block on
 * every node. The commitment that would not fit fails its transaction.
 */
describe("applyZkCommitmentAdd at the tree's capacity", () => {
    const capacity = 2 ** 20
    const commitment = (n: number) => edit({ commitment_hash: n.toString(16).padStart(64, "0") })

    it("takes the last leaf, then refuses the next one claimed in the same block", async () => {
        treeState = { leafCount: capacity - 1 }
        try {
            const entities = caches()
            const last = await applyZkCommitmentAdd(commitment(1), false, entities)
            expect(last.success).toBe(true)
            const over = await applyZkCommitmentAdd(commitment(2), false, entities)
            expect(over.success).toBe(false)
            expect(over.message).toContain("full")
            expect(over.deferredWrite).toBeUndefined()
            expect(entities.zkCommitments.size).toBe(1)
        } finally {
            treeState = null
        }
    })

    it("refuses any commitment once the tree is full", async () => {
        treeState = { leafCount: capacity }
        try {
            const result = await applyZkCommitmentAdd(commitment(1), false, caches())
            expect(result.success).toBe(false)
            expect(result.deferredWrite).toBeUndefined()
        } finally {
            treeState = null
        }
    })
})
