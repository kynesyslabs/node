import { beforeEach, describe, expect, it } from "bun:test"

import { installFakeBlockDatabase, stubBlockInsertCollaborators } from "./blockInsert.fixtures"

/**
 * A block transaction that fails without saying whether it committed must
 * not pass for one that rolled back: the node would keep running with its
 * head behind a block on disk, which sync then skips.
 */

let lostReply = false
let lookupFails = false
let rollBack = false
const durable = installFakeBlockDatabase(
    name => {
        if (rollBack && name === "Blocks") throw new Error("canceling statement due to statement timeout")
    },
    () => {
        if (lostReply) throw new Error("connection terminated before the COMMIT reply")
    },
)
await stubBlockInsertCollaborators({
    "src/libs/blockchain/chainTransactions": { persistConfirmedTransactionProjection: async () => {} },
    "src/libs/blockchain/chainDb": {
        getBlocksRepo: () => ({
            target: { name: "Blocks" },
            findOneBy: async ({ hash }: { hash: string }) => {
                if (lookupFails && (durable.get("Blocks")?.length ?? 0) > 0) {
                    throw new Error("database unreachable")
                }
                return (durable.get("Blocks") ?? []).find((row: any) => row.hash === hash) ?? null
            },
        }),
    },
})
const { insertBlock } = await import("./chainBlocks")
const { CommittedBlockFollowUpError } = await import("./committedBlockError")
const { default: HandleGCR } = await import("./gcr/handleGCR")
const { getSharedState } = await import("src/utilities/sharedState")

getSharedState.forkConfig = {
    ...getSharedState.forkConfig,
    osDenomination: { activationHeight: null },
    gasFeeSeparation: { activationHeight: null },
} as any

const HEIGHT = 9

const block = (): any => ({
    number: HEIGHT,
    hash: "0xblock",
    proposer: "0xp",
    next_proposer: "0xn",
    status: "confirmed",
    validation_data: { signatures: {} },
    content: { ordered_transactions: [], timestamp: 1_700_000_000 },
    attrs: {},
})

const pendingState = () =>
    HandleGCR.pendingWrite(
        {
            accounts: new Map(),
            storagePrograms: new Map(),
            tlsNotaries: new Map(),
            atomicWorks: new Map(),
            resourceSlots: new Map(),
        } as any,
        new Map(),
        [],
        [],
    )

beforeEach(() => {
    durable.clear()
    lostReply = false
    lookupFails = false
    rollBack = false
    getSharedState.lastBlockNumber = HEIGHT - 1
    getSharedState.fastSyncCount = 0
})

describe("a block transaction that fails after its commit", () => {
    it("is reported as a committed block when the block is on disk", async () => {
        lostReply = true

        const error = await insertBlock(block(), [], undefined, pendingState()).catch(e => e)

        expect(durable.get("Blocks")?.length).toBe(1)
        expect(error).toBeInstanceOf(CommittedBlockFollowUpError)
        expect(getSharedState.lastBlockNumber).toBe(HEIGHT - 1)
    })

    it("is reported as a committed block when the disk cannot be read to tell", async () => {
        lostReply = true
        lookupFails = true

        const error = await insertBlock(block(), [], undefined, pendingState()).catch(e => e)

        expect(error).toBeInstanceOf(CommittedBlockFollowUpError)
    })

    it("stays an ordinary failure when nothing was committed", async () => {
        rollBack = true

        const error = await insertBlock(block(), [], undefined, pendingState()).catch(e => e)

        expect(durable.size).toBe(0)
        expect(String(error)).toContain("statement timeout")
        expect(error).not.toBeInstanceOf(CommittedBlockFollowUpError)
    })
})
