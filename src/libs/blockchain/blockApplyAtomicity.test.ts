import { beforeEach, describe, expect, it, mock } from "bun:test"

/**
 * A block and the state its transactions produced commit in one database
 * transaction. A failure anywhere between the first state write and the
 * block row leaves nothing on disk, runs no side effect, and the node can
 * apply the same block again from the state before it.
 */

const durable = new Map<string, unknown[]>()
let failOn: string | null = null

function repoFor(staged: Map<string, unknown[]>, name: string) {
    const stage = (rows: unknown[]) => {
        if (failOn === name) throw new Error(`injected failure writing ${name}`)
        staged.set(name, [...(staged.get(name) ?? []), ...rows])
    }
    const query: any = {
        insert: () => query,
        update: () => query,
        set: () => query,
        where: () => query,
        andWhere: () => query,
        values: (rows: unknown[]) => {
            query.rows = rows
            return query
        },
        orIgnore: () => query,
        execute: async () => stage(query.rows ?? []),
    }
    return {
        create: (row: unknown) => row,
        save: async (rows: unknown) => stage(Array.isArray(rows) ? rows : [rows]),
        delete: async () => {},
        insert: async (row: unknown) => stage([row]),
        findOneBy: async () => null,
        find: async () => [],
        findOne: async () => null,
        manager: { connection: { getMetadata: () => ({ columns: [0, 1, 2] }) } },
        createQueryBuilder: () => query,
    }
}

const nameOf = (entity: any) => entity?.name ?? entity?.options?.name ?? String(entity)

function managerFor(staged: Map<string, unknown[]>) {
    const em: any = {
        getRepository: (entity: any) => repoFor(staged, nameOf(entity)),
        save: async (entity: any, rows?: unknown) =>
            repoFor(staged, rows === undefined ? "entity" : nameOf(entity)).save(
                rows === undefined ? entity : rows,
            ),
        createQueryBuilder: () => repoFor(staged, "IdentityCommitment").createQueryBuilder(),
    }
    return em
}

const fakeDataSource = {
    // Writes are staged and become durable only when the callback returns.
    transaction: async (work: (em: unknown) => Promise<unknown>) => {
        const staged = new Map<string, unknown[]>()
        const result = await work(managerFor(staged))
        for (const [name, rows] of staged) {
            durable.set(name, [...(durable.get(name) ?? []), ...rows])
        }
        return result
    },
    getRepository: (entity: any) => repoFor(durable, nameOf(entity)),
}

const datasourceModule = () => ({
    __esModule: true,
    dataSource: fakeDataSource,
    default: { getInstance: async () => ({ getDataSource: () => fakeDataSource }) },
})
mock.module("src/model/datasource", datasourceModule)
mock.module("@/model/datasource", datasourceModule)

// Only what the insert touches is replaced; every other export stays real.
const partial = async (path: string, overrides: Record<string, unknown>) => {
    const real = await import(path)
    mock.module(path, () => ({ ...real, ...overrides }))
}
// The block row is saved through the blocks repository's target
await partial("./chainDb", {
    getBlocksRepo: () => ({ target: { name: "Blocks" }, findOneBy: async () => null }),
    chunkedInsert: async (em: any, entity: any, rows: unknown[]) => {
        await em.getRepository(entity).save(rows)
        return { skipped: 0 }
    },
})
await partial("@/features/zk/merkle/updateMerkleTreeAfterBlock", {
    updateMerkleTreeAfterBlock: async () => 0,
})
await partial("./routines/tallyUpgradeVotes", { default: async () => {} })
await partial("./routines/applyNetworkUpgrade", { default: async () => {} })
await partial("./routines/loadNetworkParameters", { loadNetworkParameters: async () => {} })
await partial("src/libs/consensus/stakedSet", { getStakedSet: async () => new Set() })
await partial("./chainTransactions", { persistConfirmedTransactionProjection: async () => {} })
const { insertBlock } = await import("./chainBlocks")
const { default: HandleGCR } = await import("./gcr/handleGCR")
const { getSharedState } = await import("src/utilities/sharedState")

// No fork activation hook fires on this block
getSharedState.forkConfig = {
    ...getSharedState.forkConfig,
    osDenomination: { activationHeight: null },
    gasFeeSeparation: { activationHeight: null },
} as any

const HEIGHT = 9

function caches(): any {
    return {
        accounts: new Map([["0xaa", { pubkey: "0xaa", balance: 70n, nonce: 1 }]]),
        storagePrograms: new Map(),
        tlsNotaries: new Map(),
        atomicWorks: new Map(),
        resourceSlots: new Map(),
    }
}

function block(): any {
    return {
        number: HEIGHT,
        hash: "0xblock",
        proposer: "0xp",
        next_proposer: "0xn",
        status: "confirmed",
        validation_data: { signatures: {} },
        content: { ordered_transactions: ["0xtx"], timestamp: 1_700_000_000 },
        attrs: {},
    }
}

const tx = (): any => ({
    hash: "0xtx",
    status: "confirmed",
    signature: null,
    ed25519_signature: null,
    content: {
        type: "native",
        from: "0xaa",
        to: "0xbb",
        from_ed25519_address: "0xaa",
        amount: "1",
        nonce: 2,
        timestamp: 1_700_000_000,
        transaction_fee: { network_fee: "0", rpc_fee: "0", additional_fee: "0" },
        gcr_edits: [],
    },
    attrs: {},
    blockNumber: HEIGHT,
})

function pendingState(events: string[]) {
    return HandleGCR.pendingWrite(
        caches(),
        new Map([["0xaa", [{ txHash: "0xtx", blockNumber: HEIGHT }]]]),
        [async () => void events.push("side effect")],
        [async (em: any) => void (await em.getRepository({ name: "UsedNullifier" }).insert({ n: 1 }))],
    )
}

beforeEach(() => {
    durable.clear()
    failOn = null
    getSharedState.lastBlockNumber = HEIGHT - 1
    getSharedState.fastSyncCount = 0
})

describe("a block and its state commit together", () => {
    it("writes the state, its stamps, the deferred writes and the block, then runs the side effects", async () => {
        const events: string[] = []
        await insertBlock(block(), [tx()], undefined, pendingState(events))

        expect(durable.get("GCRMain")?.length).toBe(1)
        expect(durable.get("GCRAssignedTx")).toEqual([
            { pubkey: "0xaa", txHash: "0xtx", blockNumber: HEIGHT },
        ])
        expect(durable.get("UsedNullifier")?.length).toBe(1)
        expect(durable.get("Blocks")?.length).toBe(1)
        expect(durable.get("Transactions")?.length).toBe(1)
        // No set before this block in the fake: it records the first one
        expect(durable.get("ValidatorSetSnapshots")).toEqual([
            expect.objectContaining({ block: HEIGHT, validators: [] }),
        ])
        expect(events).toEqual(["side effect"])
        expect(getSharedState.lastBlockNumber).toBe(HEIGHT)
    })

    for (const phase of [
        "GCRMain",
        "GCRAssignedTx",
        "UsedNullifier",
        "Blocks",
        "Transactions",
        "ValidatorSetSnapshots",
    ]) {
        it(`leaves nothing on disk and runs no side effect when writing ${phase} fails`, async () => {
            failOn = phase
            const events: string[] = []

            await expect(
                insertBlock(block(), [tx()], undefined, pendingState(events)),
            ).rejects.toThrow("injected failure")

            expect(durable.size).toBe(0)
            expect(events).toEqual([])
            expect(getSharedState.lastBlockNumber).toBe(HEIGHT - 1)
        })
    }

    it("applies cleanly on a retry after a failed commit", async () => {
        failOn = "Blocks"
        await insertBlock(block(), [tx()], undefined, pendingState([])).catch(() => undefined)
        expect(durable.size).toBe(0)

        failOn = null
        const events: string[] = []
        await insertBlock(block(), [tx()], undefined, pendingState(events))

        expect(durable.get("GCRMain")?.length).toBe(1)
        expect(durable.get("Blocks")?.length).toBe(1)
        expect(events).toEqual(["side effect"])
    })

    it("a deferred apply writes nothing until the block commits it", async () => {
        const result = await HandleGCR.applyTransactions([], false, undefined, { defer: true })

        expect(result.pending).toBeDefined()
        expect(durable.size).toBe(0)
    })
})
