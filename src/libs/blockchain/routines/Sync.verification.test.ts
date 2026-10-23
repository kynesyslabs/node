/**
 * A node that syncs a block from one peer must end up in the state the
 * quorum-signed block describes, or not apply the block at all. The block hash
 * covers transaction hashes only, so what the peer serves beyond them is
 * checked against the node's own view before and while applying it.
 */

import { afterEach, beforeEach, describe, expect, it, jest, mock, spyOn } from "bun:test"
import {
    makeSignedTx,
    newAccount,
    type TestAccount,
} from "../testSupport/signedTx"

const verifyBlock = jest.fn(async (_block: unknown) => ({ valid: true }) as any)
const realVerifyBlock = await import("../validation/verifyBlock")
mock.module("../validation/verifyBlock", () => ({
    ...realVerifyBlock,
    verifyBlock,
}))

const hashGCRTables = jest.fn(async (_height: number) => ({}) as any)
const realHashGCR = await import("../gcr/gcr_routines/hashGCR")
mock.module("../gcr/gcr_routines/hashGCR", () => ({
    ...realHashGCR,
    default: hashGCRTables,
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

const { default: Chain } = await import("../chain")
const { default: HandleGCR } = await import("../gcr/handleGCR")
const { default: GCR } = await import("../gcr/gcr")
const { default: Datasource } = await import("@/model/datasource")
const { default: TxValidatorPool } = await import("../validation/txValidatorPool")
const { validateTx } = await import("../validation/txValidator")
const { getSharedState } = await import("@/utilities/sharedState")
const { isForkActive, txSignatureContext } = await import("@/forks")
const { orderDeterministically } = await import(
    "src/libs/consensus/v2/routines/deterministicOrder"
)
const { default: log } = await import("src/utilities/logger")
const { default: PeerManager } = await import("@/libs/peer/PeerManager")
const { BroadcastManager } = await import("@/libs/communications/broadcastManager")
const { syncBlock, fastSync } = await import("./Sync")

const HEIGHT = 12
const NATIVE_HASHES = { native_subnets_txs: "subnets", native_tlsnotary: "tls" }

const alice = newAccount()
const bob = newAccount()
const carol = newAccount()

const makeTx = (
    sender: TestAccount,
    options: { nonce?: number; status?: string; signer?: TestAccount } = {},
) => makeSignedTx(sender, bob, { ...options, height: HEIGHT })

function makeBlock(txs: any[], nativeTablesHashes: any = NATIVE_HASHES) {
    return {
        number: HEIGHT,
        hash: "block-hash",
        proposer: "forger",
        content: {
            // The forger commits to the canonical order
            ordered_transactions: orderDeterministically(txs).map(tx => tx.hash),
            peerlist: [],
            timestamp: 1_700_000_100,
            native_tables_hashes: nativeTablesHashes,
        },
        validation_data: { signatures: {} },
    } as any
}

const clone = (value: unknown) => JSON.parse(JSON.stringify(value))

/** A peer that serves `txs` for any transaction request. */
const servingPeer = (txs: any[]) =>
    ({
        identity: "peer-1",
        longCall: jest.fn(async () => ({ result: 200, response: clone(txs) })),
    }) as any

/** Rows of gcr_assigned_txs for the block being applied. */
let assignedRows: { txHash: string }[] = []
const queryBuilder: any = {
    select: () => queryBuilder,
    addSelect: () => queryBuilder,
    where: () => queryBuilder,
    getRawOne: async () => ({ max: null }),
    getRawMany: async () => [],
}
const fakeDatasource = {
    getDataSource: () => ({
        getRepository: () => ({
            find: async () => assignedRows,
            createQueryBuilder: () => queryBuilder,
        }),
    }),
}

const applyTransactions = spyOn(HandleGCR, "applyTransactions")
const deleteAssignedTxsForBlock = spyOn(HandleGCR, "deleteAssignedTxsForBlock")
const insertBlock = spyOn(Chain, "insertBlock")

function applyResult(result: {
    successfulTxs?: string[]
    failedTxs?: string[]
    skippedTxs?: string[]
}) {
    applyTransactions.mockImplementation((async (
        _txs: any[],
        isRollback: boolean,
    ) =>
        isRollback
            ? { successfulTxs: [], failedTxs: [], skippedTxs: [] }
            : {
                  successfulTxs: result.successfulTxs ?? [],
                  failedTxs: result.failedTxs ?? [],
                  skippedTxs: result.skippedTxs ?? [],
              }) as any)
}

const forkConfigAtStart = structuredClone(getSharedState.forkConfig)
const chainIdAtStart = getSharedState.chainId

afterEach(() => {
    getSharedState.forkConfig = structuredClone(forkConfigAtStart)
    getSharedState.chainId = chainIdAtStart
})

beforeEach(() => {
    verifyBlock.mockReset()
    verifyBlock.mockResolvedValue({ valid: true })
    hashGCRTables.mockReset()
    hashGCRTables.mockResolvedValue({ ...NATIVE_HASHES })

    spyOn(Chain, "getBlockByNumber").mockResolvedValue(null as any)
    spyOn(Chain, "getLastBlockNumber").mockResolvedValue(HEIGHT - 1)
    spyOn(Chain, "getExistingTransactionHashes").mockResolvedValue(new Set())
    spyOn(Chain, "checkTxExists").mockResolvedValue(false)
    spyOn(GCR, "getAccountNonces").mockImplementation((async (
        accounts: string[],
    ) => Object.fromEntries(accounts.map(a => [a, 0]))) as any)
    assignedRows = []
    spyOn(Datasource, "getInstance").mockResolvedValue(fakeDatasource as any)

    // The node's worker pool, running the same validation inline
    spyOn(TxValidatorPool.getInstance(), "validate").mockImplementation((async (
        txs: any[],
        isPostFork: boolean,
        domain: any,
    ) =>
        Promise.all(txs.map(tx => validateTx(tx, null, isPostFork, domain)))) as any)

    applyTransactions.mockReset()
    deleteAssignedTxsForBlock.mockReset()
    deleteAssignedTxsForBlock.mockResolvedValue(0)
    insertBlock.mockReset()
    insertBlock.mockResolvedValue({} as any)

    getSharedState.lastBlockNumber = HEIGHT - 1
    getSharedState.referenceBlockRoom = 1
})

describe("syncBlock verification", () => {
    it("syncs a correct block: applies the transactions once and inserts the block", async () => {
        const txs = [makeTx(alice), makeTx(bob)]
        const block = makeBlock(txs)
        applyResult({ successfulTxs: txs.map(tx => tx.hash) })

        const synced = await syncBlock(block, servingPeer(txs))

        expect(synced).toBe(true)
        expect(applyTransactions).toHaveBeenCalledTimes(1)
        expect(applyTransactions.mock.calls[0][1]).toBe(false)
        expect(insertBlock).toHaveBeenCalledTimes(1)
        expect(deleteAssignedTxsForBlock).not.toHaveBeenCalled()
    })

    it("derives confirmed from apply: a transaction that fails the same way here is accepted as failed", async () => {
        const ok = makeTx(alice)
        const failing = makeTx(bob, { status: "failed" })
        applyResult({ successfulTxs: [ok.hash], failedTxs: [failing.hash] })

        const synced = await syncBlock(makeBlock([ok, failing]), servingPeer([ok, failing]))

        expect(synced).toBe(true)
        expect(insertBlock).toHaveBeenCalledTimes(1)
    })

    it("rejects a block whose transaction body was altered after the hash was committed", async () => {
        const honest = makeTx(alice)
        const block = makeBlock([honest])
        const tampered = clone(honest)
        tampered.content.amount = "999999"
        tampered.content.data[1].args[1] = "999999"
        applyResult({ successfulTxs: [honest.hash] })

        const synced = await syncBlock(block, servingPeer([tampered]))

        expect(synced).toBe(false)
        expect(applyTransactions).not.toHaveBeenCalled()
        expect(insertBlock).not.toHaveBeenCalled()
    })

    it("rejects a block carrying a transaction with an invalid signature", async () => {
        const forged = makeTx(alice, { signer: carol })
        applyResult({ successfulTxs: [forged.hash] })

        const synced = await syncBlock(makeBlock([forged]), servingPeer([forged]))

        expect(synced).toBe(false)
        expect(applyTransactions).not.toHaveBeenCalled()
        expect(insertBlock).not.toHaveBeenCalled()
    })

    it("rejects a transaction the peer flipped to confirmed that fails here, and undoes what it applied", async () => {
        const ok = makeTx(alice)
        const flipped = makeTx(bob, { status: "confirmed" })
        applyResult({ successfulTxs: [ok.hash], failedTxs: [flipped.hash] })

        const synced = await syncBlock(makeBlock([ok, flipped]), servingPeer([ok, flipped]))

        expect(synced).toBe(false)
        expect(insertBlock).not.toHaveBeenCalled()
        const rollback = applyTransactions.mock.calls.find(call => call[1] === true)
        expect(rollback).toBeDefined()
        expect((rollback![0] as any[]).map(tx => tx.hash)).toEqual([ok.hash])
        expect(deleteAssignedTxsForBlock).toHaveBeenCalledWith(HEIGHT)
    })

    it("rejects a transaction the peer flipped to failed that applies here, and undoes it", async () => {
        const ok = makeTx(alice)
        const flipped = makeTx(bob, { status: "failed" })
        applyResult({ successfulTxs: [ok.hash, flipped.hash] })

        const synced = await syncBlock(makeBlock([ok, flipped]), servingPeer([ok, flipped]))

        expect(synced).toBe(false)
        expect(insertBlock).not.toHaveBeenCalled()
        // The peer-failed transaction was run here too, so it had to be undone
        const rollback = applyTransactions.mock.calls.find(call => call[1] === true)
        expect((rollback![0] as any[]).map(tx => tx.hash).sort()).toEqual(
            [ok.hash, flipped.hash].sort(),
        )
    })

    it("rejects a block whose native table hashes differ from the local state before it, without applying", async () => {
        const tx = makeTx(alice)
        hashGCRTables.mockResolvedValue({ ...NATIVE_HASHES, native_subnets_txs: "other" })
        applyResult({ successfulTxs: [tx.hash] })

        const synced = await syncBlock(makeBlock([tx]), servingPeer([tx]))

        expect(synced).toBe(false)
        expect(hashGCRTables).toHaveBeenCalledWith(HEIGHT)
        expect(applyTransactions).not.toHaveBeenCalled()
        expect(insertBlock).not.toHaveBeenCalled()
    })

    it("verifies the block signatures with the nonceEnforcement fork inactive", async () => {
        getSharedState.forkConfig = {
            ...getSharedState.forkConfig,
            nonceEnforcement: {
                ...getSharedState.forkConfig.nonceEnforcement,
                activationHeight: null,
            },
        }
        expect(isForkActive("nonceEnforcement", HEIGHT)).toBe(false)
        verifyBlock.mockResolvedValue({ valid: false, reason: "no quorum" } as any)
        const tx = makeTx(alice)
        applyResult({ successfulTxs: [tx.hash] })

        const synced = await syncBlock(makeBlock([tx]), servingPeer([tx]))

        expect(verifyBlock).toHaveBeenCalledTimes(1)
        expect(synced).toBe(false)
        expect(applyTransactions).not.toHaveBeenCalled()
        expect(insertBlock).not.toHaveBeenCalled()
    })

    it("judges transactions by the rules of the block's own height", async () => {
        const tx = makeTx(alice)
        applyResult({ successfulTxs: [tx.hash] })
        const validate = spyOn(TxValidatorPool.getInstance(), "validate")

        await syncBlock(makeBlock([tx]), servingPeer([tx]))

        const [, isPostFork, domain] = validate.mock.calls[0]
        expect(isPostFork).toBe(isForkActive("osDenomination", HEIGHT))
        expect(domain).toEqual(txSignatureContext(HEIGHT))
    })
})

describe("fast sync after a rejected block", () => {
    /** A peer at HEIGHT that serves `block` with `txs` over the batch endpoints. */
    const batchPeer = (identity: string, block: any, txs: any[]) =>
        ({
            identity,
            connection: { string: `http://${identity}` },
            status: { online: true },
            sync: { block: HEIGHT },
            longCall: jest.fn(async () => ({ result: 200, response: [clone(block)] })),
            call: jest.fn(async () => ({ result: 200, response: clone(txs) })),
        }) as any

    it("drops the peer that served a bad body and syncs the block from the next one", async () => {
        const honest = makeTx(alice)
        const block = makeBlock([honest])
        const tampered = clone(honest)
        tampered.content.amount = "999999"
        tampered.content.data[1].args[1] = "999999"

        const bad = batchPeer("bad-peer", block, [tampered])
        const good = batchPeer("good-peer", block, [honest])
        spyOn(PeerManager.getInstance(), "getAll").mockReturnValue([bad, good])
        spyOn(Math, "random").mockReturnValue(0)
        spyOn(BroadcastManager, "broadcastOurSyncData").mockResolvedValue(undefined as any)
        applyResult({ successfulTxs: [honest.hash] })
        insertBlock.mockImplementation((async (inserted: any) => {
            getSharedState.lastBlockNumber = inserted.number
            return {}
        }) as any)
        getSharedState.fastSyncCount = 1

        await fastSync([], "test")

        expect(bad.call).toHaveBeenCalledTimes(1)
        expect(good.call).toHaveBeenCalledTimes(1)
        expect(insertBlock).toHaveBeenCalledTimes(1)
        expect(applyTransactions).toHaveBeenCalledTimes(1)
        expect(getSharedState.lastBlockNumber).toBe(HEIGHT)
    })
})

describe("rejection handling", () => {
    const coolingDown = () =>
        (log.warning as any).mock.calls
            .map((call: unknown[]) => String(call[0]))
            .filter((line: string) => line.includes("cooling down peer"))

    it("cools down the peer that pushed a rejected block", async () => {
        const tx = makeTx(alice)
        const tampered = clone(tx)
        tampered.content.amount = "999999"
        ;(log.warning as any).mockClear()

        await syncBlock(makeBlock([tx]), servingPeer([tampered]))

        expect(coolingDown().some((line: string) => line.includes("peer-1"))).toBe(true)
    })

    it("rejects a pushed block from an unknown sender without touching a cooldown", async () => {
        hashGCRTables.mockResolvedValue({ ...NATIVE_HASHES, native_subnets_txs: "other" })
        ;(log.warning as any).mockClear()

        const synced = await syncBlock(makeBlock([]), undefined as any)

        expect(synced).toBe(false)
        expect(coolingDown()).toHaveLength(0)
    })

    it("undoes the transactions an apply had already assigned when it throws, and lets the error through", async () => {
        const ok = makeTx(alice)
        const other = makeTx(bob)
        applyTransactions.mockImplementation((async (_txs: any[], isRollback: boolean) => {
            if (isRollback) return { successfulTxs: [], failedTxs: [], skippedTxs: [] }
            assignedRows = [{ txHash: ok.hash }]
            throw new Error("database went away")
        }) as any)

        const failure = await syncBlock(makeBlock([ok, other]), servingPeer([ok, other])).catch(e => e)

        expect(failure.message).toBe("database went away")
        const rollback = applyTransactions.mock.calls.filter(call => call[1] === true)
        expect(rollback).toHaveLength(1)
        expect((rollback[0][0] as any[]).map(tx => tx.hash)).toEqual([ok.hash])
        expect(deleteAssignedTxsForBlock).toHaveBeenCalledWith(HEIGHT)
        expect(insertBlock).not.toHaveBeenCalled()
    })

    it("leaves state alone when a throwing apply had assigned nothing", async () => {
        const tx = makeTx(alice)
        applyTransactions.mockRejectedValue(new Error("database went away"))

        await syncBlock(makeBlock([tx]), servingPeer([tx])).catch(() => undefined)

        expect(applyTransactions.mock.calls.filter(call => call[1] === true)).toHaveLength(0)
        expect(deleteAssignedTxsForBlock).not.toHaveBeenCalled()
    })
})

describe("fast sync with a forked block", () => {
    const peerServing = (identity: string, block: any, txs: any[]) => {
        const handle = async (request: any) => {
            const message = request.params[0].message
            if (message === "getBlocks") {
                return { result: 200, response: [clone(block)] }
            }
            return { result: 200, response: clone(txs) }
        }
        return {
            identity,
            connection: { string: `http://${identity}` },
            status: { online: true },
            sync: { block: HEIGHT },
            longCall: jest.fn(handle),
            call: jest.fn(handle),
        } as any
    }

    it("treats a rejected recovered variant as no source, then syncs the block on the next round", async () => {
        const honest = makeTx(alice)
        const tampered = clone(honest)
        tampered.content.amount = "999999"
        const forkedBlock = makeBlock([honest])
        const variant = { ...makeBlock([honest]), hash: "variant-hash" }

        const primary = peerServing("primary", forkedBlock, [honest])
        const recovery = peerServing("recovery", variant, [tampered])
        spyOn(PeerManager.getInstance(), "getAll").mockReturnValue([primary, recovery])
        spyOn(Math, "random").mockReturnValue(0)
        spyOn(BroadcastManager, "broadcastOurSyncData").mockResolvedValue(undefined as any)
        // The primary's block fails quorum once; the retry finds it accepted
        verifyBlock.mockResolvedValueOnce({ valid: false, reason: "no quorum" } as any)
        applyResult({ successfulTxs: [honest.hash] })
        insertBlock.mockImplementation((async (inserted: any) => {
            getSharedState.lastBlockNumber = inserted.number
            return {}
        }) as any)
        getSharedState.fastSyncCount = 1
        ;(log.warning as any).mockClear()

        await fastSync([], "test")

        expect(insertBlock).toHaveBeenCalledTimes(1)
        expect((insertBlock.mock.calls[0][0] as any).hash).toBe("block-hash")
        expect(applyTransactions).toHaveBeenCalledTimes(1)
        expect(getSharedState.lastBlockNumber).toBe(HEIGHT)
        const cooled = (log.warning as any).mock.calls.map((c: unknown[]) => String(c[0]))
        expect(cooled.some((line: string) => line.includes("peer recovery"))).toBe(true)
    })
})
