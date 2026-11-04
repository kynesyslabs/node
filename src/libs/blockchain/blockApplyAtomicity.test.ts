import { beforeEach, describe, expect, it } from "bun:test"

import { installFakeBlockDatabase, stubBlockInsertCollaborators } from "./blockInsert.fixtures"

/**
 * A block and the state its transactions produced commit in one database
 * transaction. A failure anywhere between the first state write and the
 * block row leaves nothing on disk, runs no side effect, and the node can
 * apply the same block again from the state before it.
 */

let failOn: string | null = null
const durable = installFakeBlockDatabase(name => {
    if (failOn === name) throw new Error(`injected failure writing ${name}`)
})
await stubBlockInsertCollaborators({
    "src/libs/blockchain/chainTransactions": { persistConfirmedTransactionProjection: async () => {} },
})
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
        expect(events).toEqual(["side effect"])
        expect(getSharedState.lastBlockNumber).toBe(HEIGHT)
    })

    for (const phase of ["GCRMain", "GCRAssignedTx", "UsedNullifier", "Blocks", "Transactions"]) {
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
