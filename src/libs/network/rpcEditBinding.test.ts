/**
 * A transaction submitted over RPC is accepted on the rule peers and apply
 * use once `editBinding` is active, and on the comparison RPC always made
 * before that. The edit binding, the SDK and its serialiser are the real
 * ones; the chain, the pool and the confirmation step are replaced.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"

const logged: string[] = []
mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: () => {},
        info: () => {},
        warning: () => {},
        warn: () => {},
        error: (m: unknown) => logged.push(String(m)),
        only: () => {},
        custom: () => {},
    },
}))
mock.module("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: { getLastBlockNumber: async () => 100 },
}))
mock.module("src/libs/gossip/GossipManager", () => ({
    __esModule: true,
    default: { isEnabled: () => false },
}))
mock.module("src/libs/consensus/confirmationEstimate", () => ({
    estimateNextConfirmationBlock: async () => 101,
}))
mock.module("src/libs/blockchain/routines/validateTransaction", () => ({
    confirmTransaction: async (tx: Transaction) => ({
        data: { valid: true, reference_block: 100, message: "ok", gas_operation: null, transaction: tx },
        signature: { type: "ed25519", data: "00" },
        rpc_public_key: { type: "ed25519", data: "00" },
    }),
}))
mock.module("src/libs/blockchain/validation/txValidatorPool", () => ({
    __esModule: true,
    default: {
        getInstance: () => ({ sign: async () => ({ signature: new Uint8Array(1) }) }),
    },
}))
mock.module("src/libs/blockchain/gcr/gcr", () => ({
    __esModule: true,
    default: { getAccountBalance: async () => 1_000_000n * 1_000_000_000n },
}))

import { DemosTransactions } from "@kynesyslabs/demosdk/websdk"
import type { Transaction, ValidityData } from "@kynesyslabs/demosdk/types"
import Mempool from "src/libs/blockchain/mempool"
import { OS, PEER, SENDER, chainIs, demos, onTheWire } from "src/libs/blockchain/validation/editBinding.fixtures"

const { submitValidatedTx } = await import("./txSubmission")
const { handleValidateTransaction } = await import("./endpointValidation")

const original = (Mempool as any).addTransactionWithLock
let queued: string[] = []

beforeEach(() => {
    logged.length = 0
    queued = []
    ;(Mempool as any).addTransactionWithLock = async (tx: Transaction) => {
        queued.push(tx.hash)
        return { confirmationBlock: 101 }
    }
})

afterEach(() => {
    ;(Mempool as any).addTransactionWithLock = original
})

const edits = (tx: Transaction) => tx.content.gcr_edits as unknown as Array<Record<string, any>>

/** A signed native send whose fee edit carries a DEM number, which apply would read as 1 OS. */
async function numericGas(): Promise<Transaction> {
    const tx = onTheWire(await DemosTransactions.pay(PEER, 3n * OS, demos))
    edits(tx).filter(e => e.type === "balance" && e.operation === "remove")[1].amount = 1
    return tx
}

const envelope = (tx: Transaction) => ({ data: { transaction: tx, reference_block: 100 } }) as unknown as ValidityData

describe("RPC submission", () => {
    it("refuses a native transaction with a numeric gas edit once editBinding is active", async () => {
        chainIs(true, 0)
        const tx = await numericGas()

        const out = await submitValidatedTx(envelope(tx), tx)

        expect(out.ok).toBe(false)
        expect(out.error).toContain("gcr_edits")
        expect(queued).toEqual([])
    })

    it("queues the same transaction while editBinding is dormant", async () => {
        chainIs(true, null)
        const tx = await numericGas()

        const out = await submitValidatedTx(envelope(tx), tx)

        expect(out.ok).toBe(true)
        expect(queued).toEqual([tx.hash])
    })

    it("queues an unmodified transaction once active", async () => {
        chainIs(true, 0)
        const tx = onTheWire(await DemosTransactions.pay(PEER, 3n * OS, demos))

        expect((await submitValidatedTx(envelope(tx), tx)).ok).toBe(true)
        expect(queued).toEqual([tx.hash])
    })

    it("gives the verdict peers give for the same transaction", async () => {
        chainIs(true, 0)
        const { verifyAdmissionEdits } = await import("src/libs/blockchain/validation/editBinding")
        const bad = await numericGas()
        const good = onTheWire(await DemosTransactions.pay(PEER, 3n * OS, demos))

        for (const tx of [bad, good]) {
            const peer = (await verifyAdmissionEdits(tx)).ok
            expect((await submitValidatedTx(envelope(tx), tx)).ok).toBe(peer)
        }
    })
})

describe("RPC validation", () => {
    const sender = SENDER

    it("refuses a native transaction with a numeric gas edit once editBinding is active", async () => {
        chainIs(true, 0)
        const out = await handleValidateTransaction(await numericGas(), sender)

        expect(out.data.valid).toBe(false)
        expect(out.data.message).toBe("GCREdit mismatch")
    })

    it("accepts the same transaction while editBinding is dormant", async () => {
        chainIs(true, null)
        const out = await handleValidateTransaction(await numericGas(), sender)

        expect(out.data.valid).toBe(true)
    })

    it("accepts an unmodified transaction once active", async () => {
        chainIs(true, 0)
        const tx = onTheWire(await DemosTransactions.pay(PEER, 3n * OS, demos))

        expect((await handleValidateTransaction(tx, sender)).data.valid).toBe(true)
    })
})
