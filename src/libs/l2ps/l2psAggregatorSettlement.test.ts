/**
 * The batch aggregator under `l2psSettlement`: cycles go through the
 * settlement loop, the old batch prover never starts, batched rows wait for
 * their L1 batch instead of being swept, and a submitted batch carries the
 * settlement record and the node's head as its reference block (a batch with
 * reference block 0 is outside every peer's window once the chain is past it).
 */
import { afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test"
import { mockLogger } from "@/libs/blockchain/testSupport/mockMempoolDeps"

const cleanupByStatus = jest.fn(async (..._args: unknown[]) => 0)
const cleanupBatchedWithoutEdits = jest.fn(async (..._args: unknown[]) => 0)
const getExecutedSubnets = jest.fn(async () => [] as string[])
const constructed = jest.fn()
const added: any[] = []
let unfit: string | null = null
let poolError: string | null = null

mock.module("@/libs/blockchain/l2ps_mempool", () => ({
    __esModule: true,
    default: { cleanupByStatus, cleanupBatchedWithoutEdits, getExecutedSubnets, cleanupByAge: async () => 0 },
    L2PS_STATUS: {
        PENDING: "pending",
        PROCESSED: "processed",
        EXECUTED: "executed",
        FAILED: "failed",
        BATCHED: "batched",
        CONFIRMED: "confirmed",
    },
}))
mock.module("@/libs/l2ps/zk/L2PSBatchProver", () => ({
    L2PSBatchProver: class {
        constructor() {
            constructed()
        }
        initialize = async () => {}
        terminate = async () => {}
    },
}))
mock.module("@/libs/blockchain/validation/txValidatorPool", () => ({
    __esModule: true,
    default: { getInstance: () => ({ sign: async () => ({ signature: new Uint8Array(64) }) }) },
}))
mock.module("@/libs/blockchain/mempool", () => ({
    __esModule: true,
    default: {
        permanentRefusal: () => unfit,
        addTransaction: async (tx: unknown) => {
            if (poolError) return { confirmationBlock: null, error: poolError }
            added.push(tx)
            return { confirmationBlock: 541, error: null }
        },
    },
}))
mock.module("@/libs/l2ps/L2PSProofManager", () => ({ __esModule: true, default: {} }))
mock.module("@/libs/l2ps/L2PSTransactionExecutor", () => ({
    __esModule: true,
    L2PS_TX_FEE: 1,
    default: { updateTransactionStatus: async () => undefined, scrubStoredPlaintext: async () => 0 },
}))
mockLogger()

import { cloneDefaultForkConfig } from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"

const { L2PSBatchAggregator } = await import("./L2PSBatchAggregator")
const aggregator = L2PSBatchAggregator.getInstance() as any

const saved = {
    forkConfig: getSharedState.forkConfig,
    lastBlockNumber: getSharedState.lastBlockNumber,
    keypair: getSharedState.keypair,
}
const record = {
    version: 1,
    transfers: [{ commitment: "0x" + "01".repeat(32), signer: "0x" + "02".repeat(32), nonce: "1", fee: "3", signature: "0x" + "03".repeat(64) }],
    changes: [{ account: "0x" + "02".repeat(32), delta: "-3" }],
    proof: { protocol: "plonk" },
}

beforeEach(() => {
    getSharedState.forkConfig = cloneDefaultForkConfig()
    getSharedState.forkConfig.l2psSettlement.activationHeight = 0
    getSharedState.lastBlockNumber = 541
    ;(getSharedState as any).keypair = { publicKey: new Uint8Array(32).fill(7), privateKey: new Uint8Array(64).fill(9) }
    added.length = 0
    unfit = null
    poolError = null
    cleanupBatchedWithoutEdits.mockClear()
    getExecutedSubnets.mockClear()
    constructed.mockClear()
})

afterEach(async () => {
    await aggregator.stop()
    aggregator.settlement = null
    Object.assign(getSharedState, saved)
})

describe("L2PSBatchAggregator under l2psSettlement", () => {
    it("never starts the old batch prover, even with L2PS_ZK_ENABLED", async () => {
        aggregator.zkRequested = true
        await aggregator.start()
        expect(constructed).not.toHaveBeenCalled()
        aggregator.zkRequested = false
    })

    it("runs the settlement loop instead of the old aggregation", async () => {
        const cycle = jest.fn(async () => ({ submitted: 2, transfers: 7 }))
        aggregator.settlement = { cycle }
        aggregator.isRunning = true
        await aggregator.safeAggregateAndSubmit()
        expect(cycle).toHaveBeenCalledTimes(1)
        expect(getExecutedSubnets).not.toHaveBeenCalled()
        expect(aggregator.getStatistics().totalTransactionsBatched).toBe(7)
        aggregator.isRunning = false
    })

    it("does not sweep batched rows, which wait for their L1 batch", async () => {
        await aggregator.cleanupOldBatchedTransactions()
        expect(cleanupBatchedWithoutEdits).not.toHaveBeenCalled()
    })

    it("submits the settlement record without the old proof, referenced at the node's head", async () => {
        const rows = [{ hash: "a".repeat(64), original_hash: "b".repeat(64), encrypted_tx: { content: {} } }]
        const payload = await aggregator.createBatchPayload("subnet", rows, record)
        expect(payload.settlement).toEqual(record)
        expect(payload.zk_proof).toBeUndefined()

        const hash = await aggregator.submitBatchToMempool(payload)
        expect(typeof hash).toBe("string")
        expect(added).toHaveLength(1)
        expect(added[0].hash).toBe(hash)
        expect(added[0].reference_block).toBe(541)
        expect(added[0].content.data).toEqual(["l2psBatch", payload])
        expect(added[0].content.transaction_fee.network_fee).toBe(0)
    })

    it("tells a refusal no retry can change from one that may pass later", async () => {
        const rows = [{ hash: "a".repeat(64), original_hash: "b".repeat(64), encrypted_tx: { content: {} } }]
        const payload = await aggregator.createBatchPayload("subnet", rows, record)

        unfit = "transaction is larger than a block"
        expect(await aggregator.sendBatch(payload)).toEqual({ ok: false, permanent: true, reason: unfit })
        expect(added).toHaveLength(0)

        unfit = null
        poolError = "mempool is full"
        expect(await aggregator.sendBatch(payload)).toEqual({ ok: false, permanent: false, reason: poolError })

        poolError = null
        const sent = await aggregator.sendBatch(payload)
        expect(sent).toEqual({ ok: true, l1TxHash: added[0].hash })
    })
})
