import { describe, expect, it, mock } from "bun:test"
import { createHash } from "node:crypto"

/**
 * The table hashes go into every block, so two validators must get the same
 * bytes from the same rows whatever collation their database sorts text by.
 * The orders below are what the pinned postgres:16-alpine image (musl, bytes)
 * and a glibc en_US.utf8 database return for the same keys.
 */

const BYTE_ORDER = ["0x1", "A_b", "B", "a c", "a-c", "a.c", "a_b", "ab", "b", "z", "é"]
const GLIBC_ORDER = ["0x1", "a_b", "ab", "A_b", "a c", "a-c", "a.c", "b", "B", "é", "z"]

let order = BYTE_ORDER

const rowsOf: Record<string, (key: string) => object> = {
    GCRSubnetsTxs: key => ({ tx_hash: key, subnet_id: "s" }),
    GCRTLSNotary: key => ({
        tokenId: key,
        owner: "o",
        domain: "d",
        proof: "p",
        storageType: "onchain",
        txhash: "t",
        proofTimestamp: "1",
        createdAt: null,
    }),
    GCRAtomicWork: key => ({ workId: key, status: "won" }),
    GCRResourceSlot: key => ({ resourceKey: key, record: { key } }),
    GCRStorageProgram: key => ({
        storageAddress: key,
        owner: "o",
        data: { key },
        lastModifiedByTx: "t",
        isDeleted: false,
    }),
}

const repository = (entity: { name: string }) => {
    const rows = () => order.map(rowsOf[entity.name])
    return {
        find: async () => rows(),
        createQueryBuilder: () => {
            const query = {
                where: () => query,
                orderBy: () => query,
                getMany: async () => rows(),
            }
            return query
        },
    }
}

const dataSource = { getRepository: repository }
const datasourceModule = () => ({
    __esModule: true,
    dataSource,
    default: { getInstance: async () => ({ getDataSource: () => dataSource }) },
})
mock.module("src/model/datasource", datasourceModule)
mock.module("@/model/datasource", datasourceModule)

const { hashSubnetsTxsTable, hashTLSNotaryTable, hashAtomicWorkTables } = await import(
    "./hashGCR"
)

const sha256Hex = (text: string) => createHash("sha256").update(text).digest("hex")

async function hashesUnder(rowOrder: string[]) {
    order = rowOrder
    return {
        subnets: await hashSubnetsTxsTable(),
        tlsn: await hashTLSNotaryTable(),
        atomicWork: await hashAtomicWorkTables(),
    }
}

describe("table hashes and the database collation", () => {
    it("give the same bytes whether the database sorts by bytes or by a glibc locale", async () => {
        expect(GLIBC_ORDER).not.toEqual(BYTE_ORDER)
        expect(await hashesUnder(GLIBC_ORDER)).toEqual(await hashesUnder(BYTE_ORDER))
    })

    it("are what the byte-ordered database has always produced", async () => {
        const hashes = await hashesUnder(BYTE_ORDER)
        expect(hashes.subnets).toBe(
            sha256Hex(JSON.stringify(BYTE_ORDER.map(rowsOf.GCRSubnetsTxs))),
        )
        expect(hashes.tlsn).toBe(
            sha256Hex(JSON.stringify(BYTE_ORDER.map(rowsOf.GCRTLSNotary))),
        )
    })
})
