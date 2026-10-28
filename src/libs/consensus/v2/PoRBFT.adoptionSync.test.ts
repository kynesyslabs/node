/**
 * Taking a member's block runs through the real sync path and the real
 * syncLock. Only the database, the network and block-signature checks are
 * stubbed, so these cover what a mocked syncBlock cannot: a push applying
 * under the lock is never applied a second time by an adoption waiting on
 * it, and a block whose insert and undo both fail leaves the round unable to
 * fall back to its own tally.
 */

import { beforeEach, describe, expect, it, jest, mock, spyOn } from "bun:test"
import { makeSignedTx, newAccount } from "src/libs/blockchain/testSupport/signedTx"

const realVerifyBlock = await import("src/libs/blockchain/validation/verifyBlock")
// Signatures a block must carry to verify; the hash does not cover them
let quorumSignatures = 0
mock.module("src/libs/blockchain/validation/verifyBlock", () => ({
    ...realVerifyBlock,
    verifyBlock: async (b: any) =>
        Object.keys(b?.validation_data?.signatures ?? {}).length >= quorumSignatures
            ? { valid: true }
            : { valid: false, reason: "signatures short of a quorum" },
}))

const NATIVE_HASHES = { native_subnets_txs: "subnets", native_tlsnotary: "tls" }
const realHashGCR = await import("src/libs/blockchain/gcr/gcr_routines/hashGCR")
mock.module("src/libs/blockchain/gcr/gcr_routines/hashGCR", () => ({
    ...realHashGCR,
    default: async () => ({ ...NATIVE_HASHES }),
}))

mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        only: jest.fn(),
    },
}))

const { default: chain } = await import("src/libs/blockchain/chain")
const { default: handleGCR } = await import("src/libs/blockchain/gcr/handleGCR")
const { default: gcr } = await import("src/libs/blockchain/gcr/gcr")
const { default: datasource } = await import("@/model/datasource")
const { default: txValidatorPool } = await import(
    "src/libs/blockchain/validation/txValidatorPool"
)
const { validateTx } = await import("src/libs/blockchain/validation/txValidator")
const { getSharedState } = await import("@/utilities/sharedState")
const { orderDeterministically } = await import("./routines/deterministicOrder")
const { default: peerManager } = await import("@/libs/peer/PeerManager")
const broadcasting = await import("@/libs/communications/broadcastManager")
const { fastSync, syncLock, unreconciledGcrBlockNumber } = await import(
    "src/libs/blockchain/routines/Sync"
)
const { adoptReportedCommit } = await import("./PoRBFT")
const { adoptBlockFromPeers } = await import("./routines/committedBlock")
const secretaryTypes = await import("./types/secretaryManager")

const HEIGHT = 12
const PARENT_HASH = "parent-hash"

const alice = newAccount()
const bob = newAccount()

const clone = (value: unknown) => JSON.parse(JSON.stringify(value))

function makeBlock(txs: any[]) {
    return {
        number: HEIGHT,
        hash: "block-hash",
        proposer: "forger",
        content: {
            previousHash: PARENT_HASH,
            ordered_transactions: orderDeterministically(txs).map(tx => tx.hash),
            peerlist: [],
            timestamp: 1_700_000_100,
            native_tables_hashes: NATIVE_HASHES,
        },
        validation_data: { signatures: {} },
    } as any
}

/** A member serving `block` through getBlocks and its bodies through the tx endpoint. */
const member = (identity: string, block: any, txs: any[]) =>
    ({
        identity,
        connection: { string: `http://${identity}` },
        call: jest.fn(async () => ({ result: 200, response: [clone(block)] })),
        longCall: jest.fn(async () => ({ result: 200, response: clone(txs) })),
    }) as any

const queryBuilder: any = {
    select: () => queryBuilder,
    addSelect: () => queryBuilder,
    where: () => queryBuilder,
    getRawOne: async () => ({ max: null }),
    getRawMany: async () => [],
}
let assignedRows: { txHash: string }[] = []
const fakeDatasource = {
    getDataSource: () => ({
        getRepository: () => ({
            find: async () => assignedRows,
            createQueryBuilder: () => queryBuilder,
        }),
    }),
}

let stored: Record<number, any> = {}
const applyTransactions = spyOn(handleGCR, "applyTransactions")
const insertBlock = spyOn(chain, "insertBlock")
let knownPeers: Record<string, any> = {}

const forwardApplies = () =>
    applyTransactions.mock.calls.filter(call => call[1] === false)
const rollbacks = () =>
    applyTransactions.mock.calls.filter(call => call[1] === true)

/** Records an insert the way chain.insertBlock moves the head. */
function landInsert(inserted: any) {
    stored[inserted.number] = inserted
    getSharedState.lastBlockNumber = inserted.number
    getSharedState.lastBlockHash = inserted.hash
}

beforeEach(() => {
    stored = {}
    knownPeers = {}
    assignedRows = []
    spyOn(chain, "getBlockByNumber").mockImplementation((async (n: number) =>
        stored[n] ?? null) as any)
    spyOn(chain, "getBlockByHash").mockImplementation((async (hash: string) =>
        Object.values(stored).find(b => b.hash === hash) ?? null) as any)
    spyOn(chain, "getLastBlockNumber").mockImplementation((async () =>
        getSharedState.lastBlockNumber) as any)
    spyOn(chain, "getExistingTransactionHashes").mockResolvedValue(new Set())
    spyOn(chain, "checkTxExists").mockResolvedValue(true)
    spyOn(gcr, "getAccountNonces").mockImplementation((async (
        accounts: string[],
    ) => Object.fromEntries(accounts.map(a => [a, 0]))) as any)
    spyOn(datasource, "getInstance").mockResolvedValue(fakeDatasource as any)
    spyOn(txValidatorPool.getInstance(), "validate").mockImplementation((async (
        txs: any[],
        isPostFork: boolean,
        domain: any,
    ) =>
        Promise.all(txs.map(tx => validateTx(tx, null, isPostFork, domain)))) as any)
    spyOn(handleGCR, "deleteAssignedTxsForBlock").mockResolvedValue(0)
    spyOn(broadcasting.BroadcastManager, "broadcastOurSyncData").mockResolvedValue(
        undefined as any,
    )
    spyOn(peerManager.getInstance(), "getPeer").mockImplementation(((
        id: string,
    ) => knownPeers[id]) as any)
    // Our own peer entry is set up at node start, which these tests skip
    Object.defineProperty(peerManager.getInstance(), "ourSyncDataString", {
        configurable: true,
        get: () => "",
    })

    applyTransactions.mockReset()
    insertBlock.mockReset()

    getSharedState.lastBlockNumber = HEIGHT - 1
    getSharedState.lastBlockHash = PARENT_HASH
    getSharedState.referenceBlockRoom = 1
    getSharedState.isInitialized = true
    getSharedState.inSyncLoop = false
    getSharedState.fastSyncCount = 1
    quorumSignatures = 0
})

/** Forward applies always succeed; rollbacks too. */
function applyCleanly(txs: any[]) {
    applyTransactions.mockImplementation((async (_txs: any[], isRollback: boolean) =>
        isRollback
            ? { successfulTxs: [], failedTxs: [], skippedTxs: [] }
            : { successfulTxs: txs.map(tx => tx.hash), failedTxs: [], skippedTxs: [] }) as any)
    insertBlock.mockImplementation((async (inserted: any) => {
        landInsert(inserted)
        return {}
    }) as any)
}

// The drift latch lives for the whole process, as it does on a node, so the
// test that sets it runs last.
describe("adopting a member's block through the real sync path", () => {
    it("waits while a pushed block applies under syncLock, then finds it held instead of applying it again", async () => {
        const txs = [makeSignedTx(alice, bob, { height: HEIGHT })]
        const block = makeBlock(txs)
        const pusher = member("pusher", block, txs)
        knownPeers = { pusher }
        applyTransactions.mockImplementation((async (_txs: any[], isRollback: boolean) =>
            isRollback
                ? { successfulTxs: [], failedTxs: [], skippedTxs: [] }
                : { successfulTxs: txs.map(tx => tx.hash), failedTxs: [], skippedTxs: [] }) as any)

        let insertReached!: () => void
        const reachedInsert = new Promise<void>(resolve => (insertReached = resolve))
        let finishInsert!: () => void
        const insertGate = new Promise<void>(resolve => (finishInsert = resolve))
        insertBlock.mockImplementation((async (inserted: any) => {
            insertReached()
            await insertGate
            landInsert(inserted)
            return {}
        }) as any)

        // What the syncNewBlock handler does with a pushed block
        const push = syncLock.runExclusive(() =>
            broadcasting.BroadcastManager.handleNewBlock("pusher", clone(block)),
        )
        await reachedInsert

        let adoptionSettled = false
        const adoption = adoptReportedCommit(HEIGHT, [
            { peer: pusher, hash: block.hash },
        ]).finally(() => {
            adoptionSettled = true
        })
        // The adoption fetches the block outside the lock, then queues on it
        while (pusher.call.mock.calls.length === 0) await Bun.sleep(1)
        await Bun.sleep(20)
        expect(adoptionSettled).toBe(false)
        expect(syncLock.isLocked()).toBe(true)

        finishInsert()
        expect(await adoption).toBe(true)
        expect((await push).result).toBe(200)

        expect(insertBlock).toHaveBeenCalledTimes(1)
        expect(forwardApplies()).toHaveLength(1)
        expect(rollbacks()).toHaveLength(0)
        expect(getSharedState.lastBlockNumber).toBe(HEIGHT)
    })

    it("verifies each source on its own copy, so a copy short of a quorum does not hide a certified one", async () => {
        const txs = [makeSignedTx(alice, bob, { height: HEIGHT })]
        const partial = makeBlock(txs)
        partial.validation_data.signatures = { a: "sig-a" }
        const certified = makeBlock(txs)
        certified.validation_data.signatures = { a: "sig-a", b: "sig-b", c: "sig-c" }
        const early = member("early", partial, txs)
        const full = member("full", certified, txs)
        quorumSignatures = 3
        applyCleanly(txs)

        expect(await adoptBlockFromPeers(HEIGHT, [early, full], "test")).toBe(true)

        expect(insertBlock).toHaveBeenCalledTimes(1)
        expect(Object.keys(insertBlock.mock.calls[0][0].validation_data.signatures)).toHaveLength(3)
        // rejected on its signatures, before any body was fetched from it
        expect(early.longCall).not.toHaveBeenCalled()
    })

    it("cuts off a source stalling on its transactions at the deadline, before applying anything", async () => {
        const txs = [makeSignedTx(alice, bob, { height: HEIGHT })]
        const block = makeBlock(txs)
        const stalled = member("stalled", block, txs)
        stalled.longCall.mockImplementation(() => new Promise(() => undefined))
        applyCleanly(txs)

        const started = Date.now()
        const adopted = await adoptBlockFromPeers(HEIGHT, [stalled], "test", 3_000, 150)

        expect(adopted).toBe(false)
        expect(Date.now() - started).toBeLessThan(1_000)
        expect(applyTransactions).not.toHaveBeenCalled()
        expect(insertBlock).not.toHaveBeenCalled()
        expect(syncLock.isLocked()).toBe(false)
    })

    it("moves on to the next source while budget remains", async () => {
        const txs = [makeSignedTx(alice, bob, { height: HEIGHT })]
        const block = makeBlock(txs)
        const failing = member("failing", block, txs)
        failing.longCall.mockImplementation(async () => {
            await Bun.sleep(30)
            return { result: 400, response: "Max retries reached" }
        })
        const serving = member("serving", block, txs)
        applyCleanly(txs)

        expect(
            await adoptBlockFromPeers(HEIGHT, [failing, serving], "test", 3_000, 2_000),
        ).toBe(true)
        expect(serving.longCall).toHaveBeenCalled()
        expect(insertBlock).toHaveBeenCalledTimes(1)
    })

    it("aborts instead of falling back to its tally when the block's insert and its undo both fail", async () => {
        const txs = [makeSignedTx(alice, bob, { height: HEIGHT })]
        const block = makeBlock(txs)
        const first = member("first", block, txs)
        const second = member("second", block, txs)
        applyTransactions.mockImplementation((async (_txs: any[], isRollback: boolean) =>
            isRollback
                ? { successfulTxs: [], failedTxs: txs.map(tx => tx.hash), skippedTxs: [] }
                : { successfulTxs: txs.map(tx => tx.hash), failedTxs: [], skippedTxs: [] }) as any)
        insertBlock.mockRejectedValue(new Error("connection reset during insert"))
        expect(unreconciledGcrBlockNumber()).toBeNull()
        getSharedState.syncStatus = true

        const outcome = await adoptReportedCommit(HEIGHT, [
            { peer: first, hash: block.hash },
            { peer: second, hash: block.hash },
        ]).catch(e => e)

        expect(outcome).toBeInstanceOf(secretaryTypes.AbortConsensusError)
        expect(unreconciledGcrBlockNumber()).toBe(HEIGHT)
        expect(getSharedState.syncStatus).toBe(false)
        expect(insertBlock).toHaveBeenCalledTimes(1)
        expect(rollbacks()).toHaveLength(1)
        // sync would refuse the second source anyway; it is not even asked for bodies
        const askedForBodies = [first, second].filter(
            p => p.longCall.mock.calls.length > 0,
        )
        expect(askedForBodies).toHaveLength(1)
        expect(getSharedState.lastBlockNumber).toBe(HEIGHT - 1)
    })

    it("keeps the drifted node out of rounds: a fast sync at the tip no longer reports it synced", async () => {
        expect(unreconciledGcrBlockNumber()).toBe(HEIGHT)
        const level = {
            identity: "level",
            connection: { string: "http://level" },
            status: { online: true },
            sync: { block: HEIGHT - 1, status: true },
        } as any
        spyOn(peerManager.getInstance(), "getAll").mockReturnValue([level])
        getSharedState.syncStatus = true

        await fastSync([], "test")

        expect(getSharedState.syncStatus).toBe(false)
    })
})
