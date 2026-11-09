/**
 * A node that syncs a block from one peer must end up in the state the
 * quorum-signed block describes, or not apply the block at all. The block hash
 * covers transaction hashes only, so what the peer serves beyond them is
 * checked against the node's own view before and while applying it.
 */

import { afterEach, beforeEach, describe, expect, it, jest, mock, spyOn } from "bun:test"
import { createHash } from "node:crypto"
import {
    makeSignedTx,
    newAccount,
    type TestAccount,
} from "../testSupport/signedTx"

const verifyBlock = jest.fn(async (_block: unknown) => ({ valid: true }) as any)
const verifyBlockCertificate = jest.fn(
    async (_block: unknown) => ({ valid: false, reason: "no quorum" }) as any,
)
const realVerifyBlock = await import("../validation/verifyBlock")
mock.module("../validation/verifyBlock", () => ({
    ...realVerifyBlock,
    verifyBlock,
    verifyBlockCertificate,
}))

const hashGCRTables = jest.fn(async (_height: number) => ({}) as any)
const realHashGCR = await import("../gcr/gcr_routines/hashGCR")
mock.module("../gcr/gcr_routines/hashGCR", () => ({
    ...realHashGCR,
    default: hashGCRTables,
}))

const gracefulShutdown = jest.fn(async (_signal: string, _exitCode?: number) => {})
mock.module("src/index", () => ({ gracefulShutdown }))

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
const { default: Mempool } = await import("../mempool")
const { CommittedBlockFollowUpError } = await import("../committedBlockError")
const { signingHaltReason, __resetSigningHalt } = await import(
    "@/libs/identity/signingRecord"
)
const {
    syncBlock,
    fastSync,
    waitForInFlightBlockApply,
    assertNoUnreconciledGcrState,
} = await import("./Sync")

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

/** The uncommitted state an apply hands back for the block to commit. */
const PENDING = { write: async () => {}, afterCommit: async () => {} }

function applyResult(result: {
    successfulTxs?: string[]
    failedTxs?: string[]
    skippedTxs?: string[]
}) {
    applyTransactions.mockImplementation((async (
        _txs: any[],
        isRollback: boolean,
        _clock: unknown,
        options?: { defer?: boolean },
    ) =>
        isRollback
            ? { successfulTxs: [], failedTxs: [], skippedTxs: [] }
            : {
                  successfulTxs: result.successfulTxs ?? [],
                  failedTxs: result.failedTxs ?? [],
                  skippedTxs: result.skippedTxs ?? [],
                  pending: options?.defer ? PENDING : undefined,
              }) as any)
}

const forkConfigAtStart = structuredClone(getSharedState.forkConfig)
const chainIdAtStart = getSharedState.chainId

afterEach(() => {
    getSharedState.forkConfig = structuredClone(forkConfigAtStart)
    getSharedState.chainId = chainIdAtStart
    getSharedState.runMainLoop = true
    getSharedState.isShuttingDown = false
    __resetSigningHalt()
})

beforeEach(() => {
    verifyBlock.mockReset()
    verifyBlock.mockResolvedValue({ valid: true })
    verifyBlockCertificate.mockReset()
    verifyBlockCertificate.mockResolvedValue({ valid: false, reason: "no quorum" })
    hashGCRTables.mockReset()
    hashGCRTables.mockResolvedValue({ ...NATIVE_HASHES })

    spyOn(Chain, "getBlockByNumber").mockResolvedValue(null as any)
    spyOn(Chain, "getLastBlockNumber").mockResolvedValue(HEIGHT - 1)
    spyOn(Chain, "getLastStoredBlockNumber").mockResolvedValue(HEIGHT - 1)
    spyOn(queryBuilder, "getRawOne").mockResolvedValue({ max: null })
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
    getSharedState.runMainLoop = true
})

describe("GCR drift check during shutdown", () => {
    it("refuses pushed blocks and drift checks before touching state", async () => {
        getSharedState.runMainLoop = false
        const db = spyOn(Datasource, "getInstance")
        expect(await syncBlock(makeBlock([]), servingPeer([]))).toBe(false)
        await expect(assertNoUnreconciledGcrState()).rejects.toThrow("during shutdown")
        expect(db).not.toHaveBeenCalled()
        expect(applyTransactions).not.toHaveBeenCalled()
        expect(insertBlock).not.toHaveBeenCalled()
        expect(deleteAssignedTxsForBlock).not.toHaveBeenCalled()
    })

    it("uses the committed block height when memory is one block behind", async () => {
        spyOn(Chain, "getLastStoredBlockNumber").mockResolvedValue(HEIGHT)
        spyOn(queryBuilder, "getRawOne").mockResolvedValue({ max: HEIGHT })
        await assertNoUnreconciledGcrState()
        expect(applyTransactions).not.toHaveBeenCalled()
        expect(deleteAssignedTxsForBlock).not.toHaveBeenCalled()
    })
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
        expect((applyTransactions.mock.calls[0] as any[])[3]).toEqual({ defer: true })
        expect(insertBlock).toHaveBeenCalledTimes(1)
        // The state is committed by the block's own insert
        expect((insertBlock.mock.calls[0] as any[])[3]).toBe(PENDING)
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

    it("rejects a transaction the peer flipped to confirmed that fails here, committing nothing", async () => {
        const ok = makeTx(alice)
        const flipped = makeTx(bob, { status: "confirmed" })
        applyResult({ successfulTxs: [ok.hash], failedTxs: [flipped.hash] })

        const synced = await syncBlock(makeBlock([ok, flipped]), servingPeer([ok, flipped]))

        expect(synced).toBe(false)
        // The apply was held in memory, so there is nothing to insert or undo
        expect(insertBlock).not.toHaveBeenCalled()
        expect(applyTransactions.mock.calls.filter(call => call[1] === true)).toHaveLength(0)
        expect(deleteAssignedTxsForBlock).not.toHaveBeenCalled()
    })

    it("rejects a transaction the peer flipped to failed that applies here, committing nothing", async () => {
        const ok = makeTx(alice)
        const flipped = makeTx(bob, { status: "failed" })
        applyResult({ successfulTxs: [ok.hash, flipped.hash] })

        const synced = await syncBlock(makeBlock([ok, flipped]), servingPeer([ok, flipped]))

        expect(synced).toBe(false)
        expect(insertBlock).not.toHaveBeenCalled()
        expect(applyTransactions.mock.calls.filter(call => call[1] === true)).toHaveLength(0)
        expect(deleteAssignedTxsForBlock).not.toHaveBeenCalled()
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

describe("fast sync under finalityProofs", () => {
    const sha256 = (s: string) => createHash("sha256").update(s).digest("hex")

    /** Block HEIGHT + 1 on top of `block`, hashing to its own hash. */
    function childOf(block: any, parentResultsRoot: string) {
        const content = {
            ordered_transactions: [],
            peerlist: [],
            previousHash: block.hash,
            timestamp: 1_700_000_200,
            native_tables_hashes: NATIVE_HASHES,
            number: HEIGHT + 1,
            parent_results_root: parentResultsRoot,
        }
        return {
            number: HEIGHT + 1,
            hash: sha256(JSON.stringify(content)),
            proposer: "forger",
            content,
            validation_data: { signatures: {} },
        } as any
    }

    const peerWith = (blocks: any[], txs: any[]) =>
        ({
            identity: "peer-1",
            connection: { string: "http://peer-1" },
            status: { online: true },
            sync: { block: HEIGHT + 1 },
            longCall: jest.fn(async () => ({ result: 200, response: clone(blocks) })),
            call: jest.fn(async () => {
                // Every round serves the same pair; one round shows the outcome
                getSharedState.fastSyncAborted = true
                return { result: 200, response: clone(txs) }
            }),
        }) as any

    async function syncPair(parentResultsRoot: (tx: any) => Promise<string>) {
        getSharedState.forkConfig.finalityProofs.activationHeight = HEIGHT + 1
        const tx = makeTx(alice)
        const block = makeBlock([tx])
        const child = childOf(block, await parentResultsRoot(tx))
        spyOn(PeerManager.getInstance(), "getAll").mockReturnValue([
            peerWith([child, block], [tx]),
        ])
        spyOn(Math, "random").mockReturnValue(0)
        spyOn(BroadcastManager, "broadcastOurSyncData").mockResolvedValue(undefined as any)
        spyOn(Chain, "getTransactionsFromHashes").mockResolvedValue([])
        applyResult({ successfulTxs: [tx.hash] })
        insertBlock.mockImplementation((async (inserted: any) => {
            getSharedState.lastBlockNumber = inserted.number
            return {}
        }) as any)
        getSharedState.fastSyncCount = 1
        getSharedState.syncStatus = true

        await fastSync([], "test")
    }

    async function confirmedRoot(tx: any): Promise<string> {
        const { leafHash, toHex } = await import("src/libs/crypto/merkle/rfc6962")
        const { jcsCanonicalize } = await import("src/libs/crypto/jcs")
        const leaf = jcsCanonicalize({ code: null, hash: tx.hash, status: "confirmed" })
        return toHex(leafHash(new TextEncoder().encode(leaf)))
    }

    it("stores a block whose results give the root the next block commits to", async () => {
        await syncPair(confirmedRoot)

        expect(insertBlock).toHaveBeenCalledTimes(2)
        expect((insertBlock.mock.calls[0][0] as any).number).toBe(HEIGHT)
        expect(getSharedState.lastBlockNumber).toBe(HEIGHT + 1)
    })

    it("stores nothing and cools the peer down when the next block's root contradicts the results", async () => {
        const warning = log.warning as any
        warning.mockClear()
        await syncPair(async () => "ab".repeat(32))

        expect(applyTransactions).toHaveBeenCalledTimes(1)
        expect(insertBlock).not.toHaveBeenCalled()
        expect(getSharedState.lastBlockNumber).toBe(HEIGHT - 1)
        // An unsigned next block is the peer's word only: the peer is set
        // aside and the block is synced from another one
        const cooled = (log.warning as any).mock.calls.map((c: unknown[]) => String(c[0]))
        expect(
            cooled.some(
                (line: string) =>
                    line.includes("peer peer-1") && line.includes(`block ${HEIGHT + 1} commits`),
            ),
        ).toBe(true)
    })

    describe("when the batch ends at the block", () => {
        const batchSizeAtStart = getSharedState.batchSyncBlockSize
        const validChild = async (tx: any, block: any) => [childOf(block, await confirmedRoot(tx))]
        afterEach(() => {
            getSharedState.batchSyncBlockSize = batchSizeAtStart
        })

        /** Serves `block` as a one-block batch and `child` when asked for the block after it. */
        async function syncLastOfBatch(
            childResponse: (tx: any, block: any) => Promise<any[]>,
            insertFailure?: Error,
            stopDuringApply = false,
            stopBeforeBatchLoop = false,
        ) {
            getSharedState.forkConfig.finalityProofs.activationHeight = HEIGHT + 1
            getSharedState.batchSyncBlockSize = 1
            const tx = makeTx(alice)
            const block = makeBlock([tx])
            const served = await childResponse(tx, block)
            const peer = peerWith([block], [tx])
            peer.longCall = jest.fn(async (request: any) => {
                const { start, limit } = request.params[0].data
                const asksForChild = start === HEIGHT + 1 && limit === 1
                if (asksForChild && stopBeforeBatchLoop) getSharedState.runMainLoop = false
                return { result: 200, response: clone(asksForChild ? served : [block]) }
            })
            spyOn(PeerManager.getInstance(), "getAll").mockReturnValue([peer])
            spyOn(Math, "random").mockReturnValue(0)
            spyOn(BroadcastManager, "broadcastOurSyncData").mockResolvedValue(undefined as any)
            spyOn(Chain, "getTransactionsFromHashes").mockResolvedValue([])
            applyResult({ successfulTxs: [tx.hash] })
            if (stopDuringApply) applyTransactions.mockImplementationOnce((async () => {
                getSharedState.runMainLoop = false
                getSharedState.isShuttingDown = true
                return { successfulTxs: [tx.hash], failedTxs: [], skippedTxs: [], pending: PENDING }
            }) as any)
            insertBlock.mockImplementation((async (inserted: any) => {
                if (insertFailure) {
                    getSharedState.fastSyncAborted = true
                    throw insertFailure
                }
                getSharedState.lastBlockNumber = inserted.number
                return {}
            }) as any)
            getSharedState.fastSyncCount = 1
            getSharedState.syncStatus = true

            await fastSync([], "test")
        }

        it("checks it against the next block fetched from the peer", async () => {
            await syncLastOfBatch(async (tx, block) => [childOf(block, await confirmedRoot(tx))])

            expect((insertBlock.mock.calls[0][0] as any).number).toBe(HEIGHT)
        })

        it("stops before processing a fetched batch when the main loop stops", async () => {
            await syncLastOfBatch(validChild, undefined, false, true)

            expect(applyTransactions).not.toHaveBeenCalled()
            expect(insertBlock).not.toHaveBeenCalled()
            expect(log.info).toHaveBeenCalledWith(
                `[batchDownloadBlocks] Shutdown in progress, stopping before block ${HEIGHT}`,
            )
        })

        it("stores nothing when the fetched next block contradicts its results", async () => {
            await syncLastOfBatch(async (_tx, block) => [childOf(block, "ab".repeat(32))])

            expect(insertBlock).not.toHaveBeenCalled()
            expect(getSharedState.lastBlockNumber).toBe(HEIGHT - 1)
        })

        it("stores nothing and cools the peer down when it serves a block that is not the child", async () => {
            (log.warning as any).mockClear()
            await syncLastOfBatch(async (tx, block) => {
                // Hashes to itself, but builds on another parent
                const impostor = childOf({ ...block, hash: "elsewhere" }, await confirmedRoot(tx))
                return [impostor]
            })

            expect(insertBlock).not.toHaveBeenCalled()
            expect(getSharedState.lastBlockNumber).toBe(HEIGHT - 1)
            const cooled = (log.warning as any).mock.calls.map((c: unknown[]) => String(c[0]))
            expect(
                cooled.some(
                    (line: string) => line.includes("peer peer-1") && line.includes("not built on it"),
                ),
            ).toBe(true)
        })

        it("still checks the block before a tail it leaves out against that tail", async () => {
            getSharedState.forkConfig.finalityProofs.activationHeight = HEIGHT + 1
            getSharedState.batchSyncBlockSize = 2
            const tx = makeTx(alice)
            const block = makeBlock([tx])
            const child = childOf(block, "ab".repeat(32))
            const peer = peerWith([child, block], [tx])
            // The network is past the child, but the peer withholds the block after it
            peer.sync = { block: HEIGHT + 2 }
            peer.longCall = jest.fn(async (request: any) => {
                const { start, limit } = request.params[0].data
                const asksForGrandchild = start === HEIGHT + 2 && limit === 1
                return { result: 200, response: clone(asksForGrandchild ? [child] : [child, block]) }
            })
            spyOn(PeerManager.getInstance(), "getAll").mockReturnValue([peer])
            spyOn(Math, "random").mockReturnValue(0)
            spyOn(BroadcastManager, "broadcastOurSyncData").mockResolvedValue(undefined as any)
            spyOn(Chain, "getTransactionsFromHashes").mockResolvedValue([])
            applyResult({ successfulTxs: [tx.hash] })
            getSharedState.fastSyncCount = 1
            getSharedState.syncStatus = true

            await fastSync([], "test")

            expect(applyTransactions).toHaveBeenCalledTimes(1)
            expect(insertBlock).not.toHaveBeenCalled()
            expect(getSharedState.lastBlockNumber).toBe(HEIGHT - 1)
        })

        it("stores nothing when the peer withholds a next block the network has", async () => {
            // A peer asked for HEIGHT + 1 answers with its highest block at or below it
            await syncLastOfBatch(async (_tx, block) => [block])

            expect(applyTransactions).not.toHaveBeenCalled()
            expect(insertBlock).not.toHaveBeenCalled()
            expect(getSharedState.lastBlockNumber).toBe(HEIGHT - 1)
        })

        it("stores the head of a peer that has no next block, whatever another peer claims", async () => {
            getSharedState.forkConfig.finalityProofs.activationHeight = HEIGHT + 1
            getSharedState.batchSyncBlockSize = 1
            const tx = makeTx(alice)
            const block = makeBlock([tx])
            const peer = peerWith([block], [tx])
            peer.sync = { block: HEIGHT }
            const claimant = {
                identity: "peer-2",
                connection: { string: "http://peer-2" },
                status: { online: true },
                sync: { block: HEIGHT - 1 },
                gossip: { height: HEIGHT + 5 },
                longCall: jest.fn(async () => ({ result: 404, response: [] })),
                call: jest.fn(async () => ({ result: 404, response: [] })),
            } as any
            spyOn(PeerManager.getInstance(), "getAll").mockReturnValue([peer, claimant])
            spyOn(Math, "random").mockReturnValue(0)
            spyOn(BroadcastManager, "broadcastOurSyncData").mockResolvedValue(undefined as any)
            spyOn(Chain, "getTransactionsFromHashes").mockResolvedValue([])
            applyResult({ successfulTxs: [tx.hash] })
            insertBlock.mockImplementation((async (inserted: any) => {
                getSharedState.lastBlockNumber = inserted.number
                return {}
            }) as any)
            getSharedState.fastSyncCount = 1
            getSharedState.syncStatus = true

            await fastSync([], "test")

            // Asked for HEIGHT + 1, the peer answered with its head
            expect(insertBlock).toHaveBeenCalledTimes(1)
            expect((insertBlock.mock.calls[0][0] as any).number).toBe(HEIGHT)
        })

        it("does not cool down the peer when local follow-up fails after commit", async () => {
            ;(log.warning as any).mockClear()
            gracefulShutdown.mockClear()
            await syncLastOfBatch(
                validChild, new CommittedBlockFollowUpError(HEIGHT, new Error("side effect failed")))
            await new Promise(resolve => setTimeout(resolve, 0))
            expect(insertBlock).toHaveBeenCalledTimes(1)
            expect(gracefulShutdown).toHaveBeenCalledWith("committed_block_follow_up", 1)
            expect((log.warning as any).mock.calls.some((call: unknown[]) =>
                String(call[0]).includes("cooling down peer peer-1"),
            )).toBe(false)
        })

        it("does not blame a peer when shutdown refuses a block during apply", async () => {
            const handleError = spyOn(await import("@/errors"), "handleError")
            ;(log.warning as any).mockClear()
            try {
                await syncLastOfBatch(validChild, undefined, true)
                expect(handleError).not.toHaveBeenCalled()
                expect((log.warning as any).mock.calls.some((call: unknown[]) =>
                    String(call[0]).includes("cooling down peer peer-1"),
                )).toBe(false)
            } finally {
                handleError.mockRestore()
            }
        })
    })
})

describe("a block whose parent was stored with a wrong failure code", () => {
    const TX = "ab".repeat(32)
    const parent = { number: HEIGHT - 1, hash: "parent-hash", content: { ordered_transactions: [TX] } }
    const storedRow = { hash: TX, status: "failed", attrs: { code: "TX_NONCE_INVALID_LOW" }, blockNumber: HEIGHT - 1 }
    const HONEST = "TX_EXPIRED_REFERENCE_BLOCK_OUT_OF_RANGE"

    async function syncChild(servedCode: string) {
        const { resultsRoot, __resetCommitmentCache } = await import("../finality/commitments")
        __resetCommitmentCache()
        const committed = await resultsRoot(
            [TX],
            new Map([[TX, { ...storedRow, attrs: { code: HONEST } }]]),
            HEIGHT - 1,
        )
        const child = makeBlock([])
        child.content.parent_results_root = committed
        spyOn(Chain, "getBlockByNumber").mockImplementation((async (n: number) =>
            n === HEIGHT - 1 ? parent : null) as any)
        spyOn(Chain, "getTransactionsFromHashes").mockResolvedValue([clone(storedRow)] as any)
        const setFailureCodes = spyOn(Chain, "setFailureCodes").mockResolvedValue(undefined)
        setFailureCodes.mockClear()
        // The block verifies on everything but the parent's stored results
        verifyBlock
            .mockResolvedValueOnce({ valid: false, parentResultsMismatch: true, reason: "parent_results_root mismatch" })
            .mockResolvedValueOnce({ valid: true })
            .mockResolvedValueOnce({ valid: true })
        applyResult({})
        const peer = servingPeer([{ hash: TX, status: "failed", attrs: { code: servedCode } }])

        const synced = await syncBlock(child, peer)
        return { synced, setFailureCodes }
    }

    it("rewrites the code to the one the verified block commits to, then stores the block", async () => {
        const { synced, setFailureCodes } = await syncChild(HONEST)

        expect(synced).toBe(true)
        expect((verifyBlock.mock.calls[1] as any[])[2]).toEqual({ skipParentResults: true })
        expect(setFailureCodes).toHaveBeenCalledWith(HEIGHT - 1, new Map([[TX, HONEST]]))
        expect(insertBlock).toHaveBeenCalledTimes(1)
    })

    it("keeps the stored code and rejects the block when the served codes do not give its root", async () => {
        const { synced, setFailureCodes } = await syncChild("TX_EXECUTE_FAILED")

        expect(synced).toBe(false)
        expect(setFailureCodes).not.toHaveBeenCalled()
        expect(insertBlock).not.toHaveBeenCalled()
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

    it("lets a throwing apply through without touching state", async () => {
        const ok = makeTx(alice)
        const other = makeTx(bob)
        applyTransactions.mockImplementation((async () => {
            throw new Error("database went away")
        }) as any)

        const failure = await syncBlock(makeBlock([ok, other]), servingPeer([ok, other])).catch(e => e)

        expect(failure.message).toBe("database went away")
        // Nothing was committed, so nothing is undone
        expect(applyTransactions.mock.calls.filter(call => call[1] === true)).toHaveLength(0)
        expect(deleteAssignedTxsForBlock).not.toHaveBeenCalled()
        expect(insertBlock).not.toHaveBeenCalled()
    })

    it("leaves state alone when the block's insert fails: the edits commit with it or not at all", async () => {
        const tx = makeTx(alice)
        applyResult({ successfulTxs: [tx.hash] })
        insertBlock.mockRejectedValue(new Error("connection reset during insert"))

        const failure = await syncBlock(makeBlock([tx]), servingPeer([tx])).catch(e => e)

        expect(failure.message).toBe("connection reset during insert")
        expect(insertBlock).toHaveBeenCalledTimes(1)
        expect((insertBlock.mock.calls[0] as any[])[3]).toBe(PENDING)
        expect(applyTransactions.mock.calls.filter(call => call[1] === true)).toHaveLength(0)
        expect(deleteAssignedTxsForBlock).not.toHaveBeenCalled()
        expect(getSharedState.syncStatus).toBe(false)
    })

    it("shuts down gracefully, with signing stopped, when the block committed but its follow-up failed", async () => {
        const tx = makeTx(alice)
        applyResult({ successfulTxs: [tx.hash] })
        insertBlock.mockRejectedValue(
            new CommittedBlockFollowUpError(HEIGHT, new Error("side effect failed")),
        )
        const exit = spyOn(process, "exit").mockImplementation((() => {
            throw new Error("process.exit called")
        }) as never)

        try {
            const failure = await syncBlock(makeBlock([tx]), servingPeer([tx])).catch(e => e)
            // The shutdown is reached through a dynamic import
            await new Promise(resolve => setTimeout(resolve, 0))

            expect(exit).not.toHaveBeenCalled()
            expect(failure).toBeInstanceOf(CommittedBlockFollowUpError)
            expect(signingHaltReason()).toContain(`Block ${HEIGHT} committed`)
            expect(gracefulShutdown).toHaveBeenCalledWith("committed_block_follow_up", 1)
            await waitForInFlightBlockApply()
            expect(getSharedState.syncStatus).toBe(false)
        } finally {
            exit.mockRestore()
        }
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

describe("a peer that serves data the block does not add up to", () => {
    const coolingDown = (identity: string) =>
        (log.warning as any).mock.calls
            .map((call: unknown[]) => String(call[0]))
            .some((line: string) => line.includes(`cooling down peer ${identity}`))

    /** Block attrs are unsigned; these claim more applied txs than the block has. */
    const withLyingAttrs = (block: any) => ({
        ...block,
        attrs: { gcrAppliedTxCount: 7, gcrAppliedTxsHash: "x", gcrAppliedTxs: [] },
    })

    function peerServing(identity: string, block: any, txs: any[], onTxs = () => {}) {
        const handle = async (request: any) => {
            if (request.params[0].message === "getBlocks") {
                return { result: 200, response: [clone(block)] }
            }
            onTxs()
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

    it("is cooled down when it pushes the block, which is refused", async () => {
        const tx = makeTx(alice)
        ;(log.warning as any).mockClear()

        const synced = await syncBlock(withLyingAttrs(makeBlock([tx])), servingPeer([tx]))

        expect(synced).toBe(false)
        expect(insertBlock).not.toHaveBeenCalled()
        expect(coolingDown("peer-1")).toBe(true)
    })

    it("is not retried in a loop: the block is synced from the next peer", async () => {
        const tx = makeTx(alice)
        const block = makeBlock([tx])
        let badServed = 0
        // Names no other test cools down: cooldowns outlive a test
        const bad = peerServing("attrs-liar", withLyingAttrs(block), [tx], () => {
            // Bounds the run should the same peer be asked again and again
            if (++badServed >= 3) getSharedState.fastSyncAborted = true
        })
        const good = peerServing("attrs-honest", block, [tx])
        spyOn(PeerManager.getInstance(), "getAll").mockReturnValue([bad, good])
        spyOn(Math, "random").mockReturnValue(0)
        spyOn(BroadcastManager, "broadcastOurSyncData").mockResolvedValue(undefined as any)
        applyResult({ successfulTxs: [tx.hash] })
        insertBlock.mockImplementation((async (inserted: any) => {
            getSharedState.lastBlockNumber = inserted.number
            return {}
        }) as any)
        getSharedState.fastSyncCount = 1
        ;(log.warning as any).mockClear()

        await fastSync([], "test")

        expect(badServed).toBe(1)
        expect(coolingDown("attrs-liar")).toBe(true)
        expect(insertBlock).toHaveBeenCalledTimes(1)
        expect(getSharedState.lastBlockNumber).toBe(HEIGHT)
    })
})

describe("the tip check on the first sync after a restart", () => {
    const OUR_TIP = "our-tip"
    const GENESIS = "genesis"

    /** A peer at HEIGHT that serves `atTip` as our last block and `block` to sync. */
    function peerAt(identity: string, atTip: any, block: any, txs: any[]) {
        const handle = async (request: any) => {
            const { message, data } = request.params[0]
            if (message === "getBlockByNumber") {
                const number = Number(data.blockNumber)
                if (number === 0) return { result: 200, response: { number: 0, hash: GENESIS } }
                return { result: 200, response: clone(atTip) }
            }
            if (message === "getBlocks") return { result: 200, response: [clone(block)] }
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

    function startFromTip(peers: any[]) {
        spyOn(PeerManager.getInstance(), "getAll").mockReturnValue(peers)
        spyOn(Chain, "getGenesisBlockHash").mockResolvedValue(GENESIS)
        spyOn(Mempool, "cleanMempool").mockResolvedValue(undefined as any)
        spyOn(Math, "random").mockReturnValue(0)
        spyOn(BroadcastManager, "broadcastOurSyncData").mockResolvedValue(undefined as any)
        insertBlock.mockImplementation((async (inserted: any) => {
            getSharedState.lastBlockNumber = inserted.number
            return {}
        }) as any)
        getSharedState.fastSyncCount = 0
        getSharedState.lastBlockHash = OUR_TIP
    }

    const fastSyncCountAtStart = getSharedState.fastSyncCount
    const lastBlockHashAtStart = getSharedState.lastBlockHash
    afterEach(() => {
        getSharedState.fastSyncCount = fastSyncCountAtStart
        getSharedState.lastBlockHash = lastBlockHashAtStart
    })

    it("does not stop on one peer's uncertified word, and syncs from a peer that agrees", async () => {
        const tx = makeTx(alice)
        const block = makeBlock([tx])
        const liar = peerAt("tip-liar", { number: HEIGHT - 1, hash: "invented" }, block, [tx])
        const honest = peerAt("tip-honest", { number: HEIGHT - 1, hash: OUR_TIP }, block, [tx])
        startFromTip([liar, honest])
        applyResult({ successfulTxs: [tx.hash] })
        ;(log.warning as any).mockClear()

        await fastSync([], "test")

        expect(verifyBlockCertificate).toHaveBeenCalledTimes(1)
        expect((log.warning as any).mock.calls.some((c: unknown[]) => String(c[0]).includes("cooling down peer tip-liar"))).toBe(true)
        expect(insertBlock).toHaveBeenCalledTimes(1)
        expect(getSharedState.lastBlockNumber).toBe(HEIGHT)
    })

    it("does not stop when the only peer disagrees without a certificate", async () => {
        const tx = makeTx(alice)
        const block = makeBlock([tx])
        startFromTip([peerAt("tip-liar", { number: HEIGHT - 1, hash: "invented" }, block, [tx])])
        applyResult({ successfulTxs: [tx.hash] })

        await expect(fastSync([], "test")).resolves.toBeDefined()
    })

    it("does not stop on a certified block from another height, and syncs from a peer that agrees", async () => {
        const tx = makeTx(alice)
        const block = makeBlock([tx])
        verifyBlockCertificate.mockResolvedValue({ valid: true })
        const stale = peerAt("tip-stale", { number: HEIGHT - 2, hash: "older-certified" }, block, [tx])
        const honest = peerAt("tip-honest", { number: HEIGHT - 1, hash: OUR_TIP }, block, [tx])
        startFromTip([stale, honest])
        applyResult({ successfulTxs: [tx.hash] })

        await fastSync([], "test")

        expect(verifyBlockCertificate).not.toHaveBeenCalled()
        expect(insertBlock).toHaveBeenCalledTimes(1)
        expect(getSharedState.lastBlockNumber).toBe(HEIGHT)
    })

    it("does not stop on a block whose height is not a number", async () => {
        const tx = makeTx(alice)
        const block = makeBlock([tx])
        verifyBlockCertificate.mockResolvedValue({ valid: true })
        const malformed = peerAt("tip-malformed", { number: { toString: null }, hash: "other" }, block, [tx])
        const honest = peerAt("tip-honest", { number: HEIGHT - 1, hash: OUR_TIP }, block, [tx])
        startFromTip([malformed, honest])
        applyResult({ successfulTxs: [tx.hash] })

        await fastSync([], "test")

        expect(insertBlock).toHaveBeenCalledTimes(1)
    })

    it("still refuses to sync when a peer serves a certified block that differs from our tip", async () => {
        const tx = makeTx(alice)
        const block = makeBlock([tx])
        verifyBlockCertificate.mockResolvedValue({ valid: true })
        startFromTip([peerAt("tip-certified", { number: HEIGHT - 1, hash: "certified" }, block, [tx])])

        await expect(fastSync([], "test")).rejects.toThrow("integrity check failed")
        expect(insertBlock).not.toHaveBeenCalled()
    })
})
