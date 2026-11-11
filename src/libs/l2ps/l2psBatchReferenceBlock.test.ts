/**
 * The l2psBatch tx the aggregator submits references the chain tip. On the
 * launch rehearsal it carried reference block 0, which every peer's deep
 * window refuses once the chain is past it, so no batch ever reached a block.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { mockLogger } from "@/libs/blockchain/testSupport/mockMempoolDeps"

const TIP = 541
const added: any[] = []

mock.module("@/libs/blockchain/l2ps_mempool", () => ({
    __esModule: true,
    default: {},
    L2PS_STATUS: {
        PENDING: "pending",
        PROCESSED: "processed",
        EXECUTED: "executed",
        FAILED: "failed",
        BATCHED: "batched",
        CONFIRMED: "confirmed",
    },
}))
mock.module("@/libs/l2ps/zk/L2PSBatchProver", () => ({ L2PSBatchProver: class {} }))
mock.module("@/libs/blockchain/validation/txValidatorPool", () => ({
    __esModule: true,
    default: { getInstance: () => ({ sign: async () => ({ signature: new Uint8Array(64) }) }) },
}))
mock.module("@/libs/blockchain/mempool", () => ({
    __esModule: true,
    default: {
        permanentRefusal: () => null,
        addTransaction: async (tx: unknown) => {
            added.push(tx)
            return { confirmationBlock: TIP + 1, error: null }
        },
    },
}))
mock.module("@/libs/blockchain/chain", () => ({
    __esModule: true,
    default: { getLastBlockNumber: async () => TIP, getTransactionStatus: async () => "unknown" },
}))
mock.module("@/libs/l2ps/L2PSProofManager", () => ({ __esModule: true, default: {} }))
mock.module("@/libs/l2ps/L2PSTransactionExecutor", () => ({ __esModule: true, L2PS_TX_FEE: 1, default: {} }))
mockLogger()

import { cloneDefaultForkConfig } from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"
import { isWithinDeepWindow } from "@/libs/blockchain/referenceBlockWindow"

const { L2PSBatchAggregator } = await import("./L2PSBatchAggregator")
const aggregator = L2PSBatchAggregator.getInstance() as any

const saved = {
    forkConfig: getSharedState.forkConfig,
    lastBlockNumber: getSharedState.lastBlockNumber,
    keypair: getSharedState.keypair,
}

beforeEach(() => {
    // The old batch format: the fix holds whether or not l2psSettlement is on.
    getSharedState.forkConfig = cloneDefaultForkConfig()
    getSharedState.lastBlockNumber = TIP
    ;(getSharedState as any).keypair = { publicKey: new Uint8Array(32).fill(7), privateKey: new Uint8Array(64).fill(9) }
    added.length = 0
})

afterEach(() => {
    Object.assign(getSharedState, saved)
})

describe("the l2psBatch transaction", () => {
    it("references the chain tip, inside every peer's window", async () => {
        const payload = {
            l2ps_uid: "subnet",
            encrypted_batch: "",
            transaction_count: 1,
            batch_hash: "c".repeat(64),
            transaction_hashes: ["a".repeat(64)],
            authentication_tag: "d".repeat(64),
        }
        const hash = await aggregator.submitBatchToMempool(payload)
        expect(hash).toBeTruthy()
        expect(added).toHaveLength(1)
        expect(added[0].reference_block).toBe(TIP)
        expect(isWithinDeepWindow(added[0].reference_block, TIP)).toBe(true)
    })
})
