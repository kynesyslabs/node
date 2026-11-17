/**
 * A settlement batch goes into the mempool only after its rows are tied to
 * it, and never after the service stopped: signing and the tip read await
 * between the loop's last stop check and the insert. A cycle that outlives
 * a timed-out stop() keeps the next start() waiting, so two loops never
 * recover and plan the same rows.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { mockLogger } from "@/libs/blockchain/testSupport/mockMempoolDeps"

const TIP = 541
const added: any[] = []
const events: string[] = []
let signHold: Promise<void> = Promise.resolve()
let insertThrows = false

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
    default: {
        getInstance: () => ({
            sign: async () => {
                await signHold
                return { signature: new Uint8Array(64) }
            },
        }),
    },
}))
mock.module("@/libs/blockchain/mempool", () => ({
    __esModule: true,
    default: {
        permanentRefusal: () => null,
        addTransaction: async (tx: any) => {
            if (insertThrows) {
                added.push(tx)
                throw new Error("connection reset")
            }
            events.push("insert")
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
import type { SubmitGate } from "./settlement/aggregator"

const { L2PSBatchAggregator } = await import("./L2PSBatchAggregator")
const aggregator = L2PSBatchAggregator.getInstance() as any

const saved = {
    forkConfig: getSharedState.forkConfig,
    lastBlockNumber: getSharedState.lastBlockNumber,
    keypair: getSharedState.keypair,
}

const payload = () => ({
    l2ps_uid: "subnet",
    encrypted_batch: "",
    transaction_count: 1,
    batch_hash: "c".repeat(64),
    transaction_hashes: ["a".repeat(64)],
    authentication_tag: "d".repeat(64),
})

function gate(overrides: Partial<SubmitGate> = {}): SubmitGate & { linked: string[] } {
    const linked: string[] = []
    return {
        linked,
        stopped: () => false,
        beforeSend: async hash => {
            events.push("link")
            linked.push(hash)
        },
        ...overrides,
    }
}

beforeEach(() => {
    getSharedState.forkConfig = cloneDefaultForkConfig()
    getSharedState.lastBlockNumber = TIP
    ;(getSharedState as any).keypair = { publicKey: new Uint8Array(32).fill(7), privateKey: new Uint8Array(64).fill(9) }
    added.length = 0
    events.length = 0
    signHold = Promise.resolve()
    insertThrows = false
})

afterEach(() => {
    Object.assign(getSharedState, saved)
})

describe("sendBatch through the settlement gate", () => {
    it("links the rows to the batch hash before the insert", async () => {
        const g = gate()
        const sent = await aggregator.sendBatch(payload(), g)

        expect(sent.ok).toBe(true)
        expect(events).toEqual(["link", "insert"])
        expect(g.linked).toEqual([sent.l1TxHash])
        expect(added[0].hash).toBe(sent.l1TxHash)
    })

    it("puts nothing in the mempool when the service stops while the batch is signed", async () => {
        let signed!: () => void
        signHold = new Promise(resolve => {
            signed = resolve
        })
        let stopped = false
        const g = gate({ stopped: () => stopped })

        const sending = aggregator.sendBatch(payload(), g)
        await new Promise(resolve => setTimeout(resolve, 0))
        stopped = true
        signed()
        const sent = await sending

        expect(sent).toMatchObject({ ok: false, permanent: false })
        expect(added).toHaveLength(0)
        expect(g.linked).toHaveLength(0)
    })

    it("puts nothing in the mempool when the batch link cannot be written", async () => {
        const g = gate({
            beforeSend: async () => {
                throw new Error("database unavailable")
            },
        })

        const sent = await aggregator.sendBatch(payload(), g)

        expect(sent).toMatchObject({ ok: false, permanent: false })
        expect(added).toHaveLength(0)
    })

    it("reports a batch whose insert threw as possibly sent", async () => {
        insertThrows = true

        const sent = await aggregator.sendBatch(payload(), gate())

        expect(sent).toMatchObject({ ok: false, permanent: false, maybeSent: true })
    })
})

describe("a cycle that outlives stop()", () => {
    it("keeps the next start() waiting until it ends", async () => {
        let release!: () => void
        const hung = new Promise<void>(resolve => {
            release = resolve
        })
        aggregator.aggregateAndSubmitBatches = () => hung
        aggregator.cleanupOldBatchedTransactions = async () => {}
        aggregator.pruneHistoryRetention = async () => {}
        aggregator.scrubLegacyPlaintext = async () => {}
        aggregator.isRunning = true

        const cycle = aggregator.safeAggregateAndSubmit()
        await aggregator.stop(20)
        expect(aggregator.isAggregating).toBe(true)

        let started = false
        const starting = aggregator.start().then(() => {
            started = true
        })
        await new Promise(resolve => setTimeout(resolve, 20))
        expect(started).toBe(false)

        release()
        await cycle
        await starting
        expect(started).toBe(true)
        expect(aggregator.isAggregating).toBe(false)
        await aggregator.stop(20)
    })
})
