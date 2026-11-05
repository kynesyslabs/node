import { afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test"
import { createHash } from "node:crypto"

/**
 * The storage root rides in `native_tables_hashes`, which the block hash
 * covers. Before the fork the map must stay exactly what it was, key order
 * included; from the fork on the root is appended after every other key.
 */

const tables: Record<string, unknown[]> = {
    GCRSubnetsTxs: [{ tx_hash: "0x01", subnet_id: "s" }],
    GCRTLSNotary: [],
    GCRAtomicWork: [],
    GCRResourceSlot: [],
}

const repository = (entity: { name: string }) => ({
    find: async () => tables[entity.name] ?? [],
    createQueryBuilder: () => {
        const query = {
            where: () => query,
            orderBy: () => query,
            getMany: async () => [],
        }
        return query
    },
})

const dataSource = { getRepository: repository }
const datasourceModule = () => ({
    __esModule: true,
    dataSource,
    default: { getInstance: async () => ({ getDataSource: () => dataSource }) },
})
mock.module("src/model/datasource", datasourceModule)
mock.module("@/model/datasource", datasourceModule)

const STORAGE_ROOT = "5".repeat(64)
const storageProgramsRoot = jest.fn(async () => STORAGE_ROOT)
mock.module("@/libs/blockchain/finality/storageRoot", () => ({
    __esModule: true,
    storageProgramsRoot,
    markStorageProgramsDirty: () => {},
    proveStoragePrograms: async () => ({ root: STORAGE_ROOT, proofs: [] }),
    StorageProofBusyError: class extends Error {},
}))

const { getSharedState } = await import("@/utilities/sharedState")
const { default: hashGCRTables } = await import("./hashGCR")

const sha256Hex = (text: string) => createHash("sha256").update(text).digest("hex")
const forkConfigAtStart = structuredClone(getSharedState.forkConfig)

function activate(forks: Record<string, number | null>) {
    const config = structuredClone(forkConfigAtStart) as any
    for (const [name, activationHeight] of Object.entries(forks)) {
        config[name] = { ...(config[name] ?? {}), activationHeight }
    }
    getSharedState.forkConfig = config
}

beforeEach(() => storageProgramsRoot.mockClear())
afterEach(() => {
    getSharedState.forkConfig = structuredClone(forkConfigAtStart)
})

describe("native_tables_hashes and the storage root", () => {
    it("is byte-identical to the pre-fork map while finalityProofs is dormant", async () => {
        activate({ atomicWork: null, finalityProofs: null })
        const hashes = await hashGCRTables(100)
        // The pre-fork spelling, rebuilt by hand from the same tables.
        const legacy = {
            native_subnets_txs: sha256Hex(JSON.stringify(tables.GCRSubnetsTxs)),
            native_tlsnotary: sha256Hex(JSON.stringify([])),
        }
        expect(JSON.stringify(hashes)).toBe(JSON.stringify(legacy))
        expect(storageProgramsRoot).not.toHaveBeenCalled()
    })

    it("stays byte-identical below the activation height", async () => {
        activate({ atomicWork: 0, finalityProofs: 50 })
        expect(Object.keys(await hashGCRTables(49))).toEqual([
            "native_subnets_txs",
            "native_tlsnotary",
            "native_atomic_work",
        ])
        expect(storageProgramsRoot).not.toHaveBeenCalled()
    })

    it("appends the root as the last key from the activation height on", async () => {
        activate({ atomicWork: 0, finalityProofs: 50 })
        const hashes = (await hashGCRTables(50)) as unknown as Record<string, string>
        expect(Object.keys(hashes)).toEqual([
            "native_subnets_txs",
            "native_tlsnotary",
            "native_atomic_work",
            "native_storage_programs",
        ])
        expect(hashes.native_storage_programs).toBe(STORAGE_ROOT)

        activate({ atomicWork: null, finalityProofs: 0 })
        expect(Object.keys(await hashGCRTables(0))).toEqual([
            "native_subnets_txs",
            "native_tlsnotary",
            "native_storage_programs",
        ])
    })
})
