/**
 * Postgres refuses U+0000 in `varchar` and `jsonb`, so a transaction carrying
 * one into a column that refuses it fails the block's commit on every node and
 * stops the chain. Admission (RPC, gossip, the mempool insert) refuses any
 * text jsonb would refuse anywhere in the transaction, and so does the
 * consensus mempool merge. The re-check of a received or synced block refuses
 * only U+0000 in a column of a row the block insert writes: anything else did
 * commit, in the json body, and history holding it must still verify.
 *
 * The transactions are signed by the real SDK signer and the validators are
 * the real ones; only the chain, the database and the worker threads are
 * replaced.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test"

let inserted: Array<Record<string, unknown>> = []

mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: { debug: () => {}, info: () => {}, warn: () => {}, warning: () => {}, error: () => {}, only: () => {}, custom: () => {} },
}))
mock.module("@/model/datasource", () => ({
    __esModule: true,
    default: { getInstance: async () => ({}) },
}))
mock.module("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: {
        getLastBlockNumber: async () => 100,
        getExistingTransactionHashes: async () => new Set<string>(),
        checkTxExists: async () => false,
    },
}))
mock.module("src/libs/blockchain/chainDb", () => ({
    chunkedInsert: async (_repo: unknown, _entity: unknown, rows: Array<Record<string, unknown>>) => {
        inserted.push(...rows)
        return { inserted: rows.length }
    },
}))
mock.module("src/libs/consensus/v2/types/secretaryManager", () => ({
    __esModule: true,
    default: class {
        static lastBlockRef = 100
    },
}))
mock.module("src/libs/blockchain/validation/identityAdmission", () => ({
    checkIdentityAdmission: async () => ({ ok: true }),
}))

// The workers run validateTx; here it runs inline.
const { validateTx } = await import("./txValidator")
mock.module("src/libs/blockchain/validation/txValidatorPool", () => ({
    __esModule: true,
    default: {
        getInstance: () => ({
            validate: async (txs: any[], isPostFork: boolean, domain: any) =>
                Promise.all(txs.map(tx => validateTx(tx, null, isPostFork, domain))),
        }),
    },
}))

import { DemosTransactions, GCRGeneration, uint8ArrayToHex } from "@kynesyslabs/demosdk/websdk"
import Hashing from "src/libs/crypto/hashing"
import { serializeTransactionContent } from "@/forks"
import { txSignaturePreimage } from "@/libs/crypto/txSignaturePreimage"
import type { Transaction, ValidityData } from "@kynesyslabs/demosdk/types"
import { OS, PEER, chainIs, demos, onTheWire } from "./editBinding.fixtures"

const { default: Mempool } = await import("../mempool")
const { default: NodeTransaction } = await import("../transaction")
const { checkTxAdmissible } = await import("./txAdmission")
const { verifyBlockTxSignatures } = await import("./verifyBlockTxSignatures")
const { verifyBlockTransactions, SyncBlockRejectedError } = await import("../routines/syncVerification")
const { verifySystemRelayTx } = await import("./systemRelayTx")

// "<64 hex>\u0000" passes the node's `to` check, which reads it through
// Buffer.from(hex) and stops at the first non-hex character.
const NUL_RECIPIENT = PEER + "\u0000"

/**
 * A transfer signed with the SDK's key. The SDK refuses to sign a `to` that is
 * not exactly 0x and 64 hex characters, so a hostile client does what this
 * does: build the transfer, swap the recipient, regenerate the edits with the
 * SDK and sign the hash itself.
 */
async function transfer(to: string): Promise<Transaction> {
    const tx = onTheWire(await DemosTransactions.pay(PEER, 5n * OS, demos))
    if (to === PEER) return tx
    tx.content.to = to
    ;(tx.content.data[1] as { args: unknown[] }).args[0] = to
    tx.content.gcr_edits = await GCRGeneration.generate(tx)
    tx.content = JSON.parse(serializeTransactionContent(tx.content, 100))
    tx.hash = Hashing.sha256(serializeTransactionContent(tx.content, 100))
    const signed = await demos.crypto.sign("ed25519", txSignaturePreimage(tx.hash, 0, false))
    tx.signature = { type: "ed25519", data: uint8ArrayToHex(signed.signature) } as never
    return tx
}

async function withMemo(key: string, value: string): Promise<Transaction> {
    const tx = DemosTransactions.empty()
    tx.content.type = "native"
    tx.content.to = PEER
    tx.content.nonce = 8
    tx.content.amount = 5n * OS as never
    tx.content.timestamp = Date.now()
    tx.content.data = ["native", { nativeOperation: "send", args: [PEER, String(5n * OS)], [key]: value }] as never
    return onTheWire(await demos.sign(tx))
}

async function withNulMemo(): Promise<Transaction> {
    const tx = DemosTransactions.empty()
    tx.content.type = "native"
    tx.content.to = PEER
    tx.content.nonce = 8
    tx.content.amount = 5n * OS as never
    tx.content.timestamp = Date.now()
    tx.content.data = ["native", { nativeOperation: "send", args: [PEER, String(5n * OS)], ["memo\u0000"]: "x" }] as never
    // The SDK signs this one itself: it checks `to` only.
    return onTheWire(await demos.sign(tx))
}

const atRpc = (tx: Transaction) => ({ ...tx, reference_block: 100 })

const validity = (tx: Transaction): ValidityData =>
    ({ data: { transaction: tx, reference_block: 100 } }) as unknown as ValidityData

const pending = (tx: Transaction) =>
    ({ ...tx, reference_block: 100, blockNumber: 100, status: "pending" }) as unknown as Transaction

// Typed loosely: the two block checks take the SDK and the node block shapes.
const blockOf = (txs: Transaction[], number = 101): any =>
    ({ number, content: { ordered_transactions: txs.map(tx => tx.hash) } })

let queued: string[] = []

beforeEach(() => {
    chainIs(true)
    inserted = []
    queued = []
    ;(Mempool as any).repo = { find: async () => [] }
    ;(Mempool as any).checkTransactionByHash = async () => null
    ;(Mempool as any).addTransactionWithLock = async (tx: Transaction) => {
        queued.push(tx.hash)
        return { confirmationBlock: 101 }
    }
})

describe("the probe transaction", () => {
    it("is coherent and correctly signed; the `to` check takes no character after 64 hex digits", async () => {
        const tx = await transfer(NUL_RECIPIENT)
        expect(tx.content.to).toBe(NUL_RECIPIENT)
        expect((NodeTransaction as any).validateToField(tx.content.to).valid).toBe(false)
        expect(NodeTransaction.checkCoherence(tx as never, 100).coherent).toBe(true)
        expect((await NodeTransaction.validateSignature(tx as never, null)).success).toBe(true)
    })
})

describe("RPC admission", () => {
    it("refuses a transfer whose `to` is 64 hex characters and U+0000", async () => {
        const verdict = await checkTxAdmissible(atRpc(await transfer(NUL_RECIPIENT)), { head: 100, checkWindow: true, checkMempool: true })
        expect(verdict).toMatchObject({ ok: false, code: "structure" })
        expect((verdict as { reason: string }).reason).toContain("U+0000")
    })

    it("refuses U+0000 in a key deep in the body", async () => {
        const verdict = await checkTxAdmissible(atRpc(await withNulMemo()), { head: 100, checkWindow: true, checkMempool: true })
        expect(verdict).toMatchObject({ ok: false, code: "structure" })
    })

    it("refuses an unpaired surrogate in the body", async () => {
        const verdict = await checkTxAdmissible(atRpc(await withMemo("memo", "\ud800")), { head: 100, checkWindow: true, checkMempool: true })
        expect(verdict).toMatchObject({ ok: false, code: "structure" })
    })

    it("still admits the same transfer to a clean address", async () => {
        expect(await checkTxAdmissible(atRpc(await transfer(PEER)), { head: 100, checkWindow: true, checkMempool: true })).toEqual({ ok: true })
    })
})

describe("gossip ingest", () => {
    it("refuses it before it reaches the pool", async () => {
        const out = await Mempool.ingestGossiped(validity(await transfer(NUL_RECIPIENT)))
        expect(out.accepted).toBe(false)
        expect(out.reason).toContain("U+0000")
        expect(queued).toHaveLength(0)
    })

    it("still takes a clean transfer", async () => {
        expect(await Mempool.ingestGossiped(validity(await transfer(PEER)))).toMatchObject({ accepted: true })
    })
})

describe("the mempool insert", () => {
    it("refuses it even when the caller skipped admission", async () => {
        const tx = await transfer(NUL_RECIPIENT)
        const out = await Mempool.addTransaction({ ...tx, reference_block: 100 } as never)
        expect(out.error).toContain("U+0000")
    })
})

describe("consensus mempool merge", () => {
    it("drops it and keeps the clean transactions of the batch", async () => {
        const bad = await transfer(NUL_RECIPIENT)
        const good = await transfer(PEER)
        await Mempool.receive([pending(bad), pending(good)], false)
        expect(inserted.map(row => row.hash)).toEqual([good.hash])
    })

    it("drops one whose U+0000 or surrogate sits only in the json body, as admission does", async () => {
        const memo = await withNulMemo()
        const surrogate = await withMemo("note", "\ud800")
        const good = await transfer(PEER)
        await Mempool.receive([pending(memo), pending(surrogate), pending(good)], false)
        expect(inserted.map(row => row.hash)).toEqual([good.hash])
    })
})

describe("received block verification", () => {
    it("rejects a block that carries it", async () => {
        const bad = await transfer(NUL_RECIPIENT)
        const verdict = await verifyBlockTxSignatures(blockOf([bad]), [bad])
        expect(verdict.valid).toBe(false)
        expect(verdict.reason).toContain("U+0000")
    })

    it("accepts the same block with a clean transfer", async () => {
        const good = await transfer(PEER)
        expect((await verifyBlockTxSignatures(blockOf([good]), [good])).valid).toBe(true)
    })

    it("accepts a block whose U+0000 or surrogate sits only in the json body", async () => {
        const txs = [await withNulMemo(), await withMemo("note", "\ud800")]
        expect(await verifyBlockTxSignatures(blockOf(txs), txs)).toEqual({ valid: true })
    })

    it("rejects a relay transaction carrying it", async () => {
        // Shaped as the L2PS batch aggregator builds it.
        const relay = {
            hash: "aa",
            content: {
                type: "l2psBatch",
                from: "x\u0000",
                to: "x",
                from_ed25519_address: "x",
                amount: 0,
                timestamp: 1_760_000_000,
                nonce: 1,
                fee: 0,
                data: ["l2psBatch", {}],
                transaction_fee: { network_fee: 0, rpc_fee: 0, additional_fee: 0, rpc_address: null },
            },
            signature: { data: "00" },
        }
        const verdict = await verifySystemRelayTx(relay as never)
        expect(verdict.valid).toBe(false)
        expect(verdict.reason).toContain("U+0000")
    })
})

describe("sync verification", () => {
    it("rejects a served block that carries it", async () => {
        const bad = { ...(await transfer(NUL_RECIPIENT)), status: "confirmed" } as Transaction
        await expect(verifyBlockTransactions(blockOf([bad]), [bad])).rejects.toBeInstanceOf(SyncBlockRejectedError)
    })

    it("syncs a historical block whose U+0000 sits only in a body memo", async () => {
        const memo = { ...(await withNulMemo()), status: "confirmed" } as Transaction
        await verifyBlockTransactions(blockOf([memo]), [memo])
    })

    it("accepts attrs served with U+0000: they are cleaned before they are stored", async () => {
        const served = { ...(await transfer(PEER)), status: "confirmed", attrs: { message: "\u0000" } } as unknown as Transaction
        await verifyBlockTransactions(blockOf([served]), [served])
    })

    it("accepts a served block with a clean transfer", async () => {
        const good = { ...(await transfer(PEER)), status: "confirmed" } as Transaction
        await verifyBlockTransactions(blockOf([good]), [good])
    })
})

describe("stored attrs", () => {
    it("never carry U+0000 or an unpaired surrogate into the jsonb column", async () => {
        const tx = NodeTransaction.fromRawTransaction(NodeTransaction.toRawTransaction(Object.assign(new NodeTransaction(), await transfer(PEER))) as never)
        tx.attrs = { message: "bad \u0000 \\u0000 \ud800", ["k\u0000"]: 1 } as never
        const raw = NodeTransaction.toRawTransaction(tx) as unknown as { attrs: Record<string, unknown> }
        expect(raw.attrs).toEqual({ message: "bad \ufffd \\u0000 \ufffd", ["k\ufffd"]: 1 })
    })
})
