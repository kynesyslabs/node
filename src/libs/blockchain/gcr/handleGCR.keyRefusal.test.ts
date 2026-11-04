/**
 * Before any edit applies, a block's rows are loaded by keys taken from the
 * edits. A key Postgres refuses (U+0000), or an account the node cannot load
 * or create, threw there, out of applyTransactions, and failed the block on
 * every node. Such a transaction now fails alone and the rest of the block
 * applies. A key with an unpaired surrogate fails too: Postgres would store
 * it as U+FFFD, so two different keys in memory would be one row.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"

const queried: unknown[] = []

/** Postgres refuses U+0000 in a text parameter: SQLSTATE 22021. */
function find({ where }: { where: Record<string, { value?: unknown }> }) {
    for (const operator of Object.values(where)) {
        const values = Array.isArray(operator?.value) ? operator.value : [operator]
        queried.push(...values)
        if (values.some(v => typeof v === "string" && v.includes("\u0000"))) {
            throw Object.assign(new Error('invalid byte sequence for encoding "UTF8": 0x00'), { code: "22021" })
        }
    }
    return Promise.resolve([])
}

const fakeDataSource = { getRepository: () => ({ find }) }
const datasourceModule = () => ({
    __esModule: true,
    dataSource: fakeDataSource,
    default: { getInstance: async () => ({ getDataSource: () => fakeDataSource }) },
})
mock.module("src/model/datasource", datasourceModule)
mock.module("@/model/datasource", datasourceModule)
mock.module("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: {
        getLastBlockNumber: async () => 100,
        getExistingTransactionHashes: async () => new Set<string>(),
    },
}))
mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: { debug: () => {}, info: () => {}, warn: () => {}, warning: () => {}, error: () => {}, only: () => {}, custom: () => {} },
}))

import { DemosTransactions, GCRGeneration, uint8ArrayToHex } from "@kynesyslabs/demosdk/websdk"
import type { Transaction } from "@kynesyslabs/demosdk/types"
import { cloneDefaultForkConfig, type ForkConfigByName } from "@/forks/forkConfig"
import { serializeTransactionContent } from "@/forks"
import Hashing from "src/libs/crypto/hashing"
import { txSignaturePreimage } from "@/libs/crypto/txSignaturePreimage"
import { getSharedState } from "@/utilities/sharedState"
import { OS, PEER, demos, onTheWire } from "@/libs/blockchain/validation/editBinding.fixtures"
import { transactionRowRefusal } from "@/libs/blockchain/validation/postgresStorable"

const { default: HandleGCR, uncreatableAccountKey } = await import("./handleGCR")
const { GCRMain } = await import("@/model/entities/GCRv2/GCR_Main")

// 64 characters after 0x, as every stored account key, the last one replaced.
const withLast = (last: string) => PEER.slice(0, -1) + last

/**
 * A transfer whose `to` is clean but whose credited account, `args[0]`, is
 * `recipient`. Its edits are the ones the SDK derives from that body, and it
 * is signed, so it passes every check a block's transactions get.
 */
async function sendTo(recipient: unknown): Promise<Transaction> {
    const tx = onTheWire(await DemosTransactions.pay(PEER, 5n * OS, demos))
    const args = (tx.content.data[1] as { args: unknown[] }).args
    args[0] = typeof recipient === "string" ? recipient : PEER
    tx.content.gcr_edits = await GCRGeneration.generate(tx)
    // The SDK only derives string accounts; a hand-made body carries any.
    if (typeof recipient !== "string") {
        args[0] = recipient
        for (const edit of tx.content.gcr_edits as unknown as Array<{ account: unknown }>) {
            if (edit.account === PEER) edit.account = recipient
        }
    }
    tx.content = JSON.parse(serializeTransactionContent(tx.content, 100))
    tx.hash = Hashing.sha256(serializeTransactionContent(tx.content, 100))
    const signed = await demos.crypto.sign("ed25519", txSignaturePreimage(tx.hash, 0, false))
    tx.signature = { type: "ed25519", data: uint8ArrayToHex(signed.signature) } as never
    return tx
}

const credited = (tx: Transaction) =>
    (tx.content.gcr_edits as unknown as Array<{ type: string; operation: string; account: unknown }>)
        .find(e => e.type === "balance" && e.operation === "add")?.account

let savedForks: ForkConfigByName
beforeEach(() => {
    queried.length = 0
    savedForks = getSharedState.forkConfig
    getSharedState.forkConfig = cloneDefaultForkConfig()
    getSharedState.forkConfig.osDenomination.activationHeight = 0
    getSharedState.forkConfig.nonceEnforcement.activationHeight = null
    getSharedState.forkConfig.gasFeeSeparation.activationHeight = null
    getSharedState.forkConfig.editBinding.activationHeight = null
    getSharedState.lastBlockNumber = 100
})
afterEach(() => {
    getSharedState.forkConfig = savedForks
})

const apply = (txs: Transaction[]) => HandleGCR.applyTransactions(txs, false, undefined, { defer: true })

describe("a credited account Postgres cannot store", () => {
    it("reaches apply: the block re-check only reads the transaction row", async () => {
        const tx = await sendTo(withLast("\u0000"))
        expect(credited(tx)).toBe(withLast("\u0000"))
        expect(tx.content.to).toBe(PEER)
        expect(transactionRowRefusal(tx as never)).toBeNull()
    })

    it("fails its transaction instead of the block, and the rest applies", async () => {
        const bad = await sendTo(withLast("\u0000"))
        const good = await sendTo(PEER)
        const out = await apply([bad, good])
        expect(out.failedTxs).toEqual([bad.hash])
        expect(out.successfulTxs).toEqual([good.hash])
        expect(queried).not.toContain(withLast("\u0000"))
    })
})

describe("keys an unpaired surrogate would merge into one row", () => {
    it("fail their transactions", async () => {
        const high = await sendTo(withLast("\ud800"))
        const low = await sendTo(withLast("\udfff"))
        const out = await apply([high, low])
        expect(out.successfulTxs).toEqual([])
        expect(out.failedTxs.sort()).toEqual([high.hash, low.hash].sort())
    })
})

describe("an account the node cannot load", () => {
    for (const [name, recipient] of [
        ["short hex, which createAccount refuses", "0x1234"],
        ["blank", "   "],
        ["a number", 5],
    ] as const) {
        it(`fails its transaction instead of throwing: ${name}`, async () => {
            const tx = await sendTo(recipient)
            const good = await sendTo(PEER)
            const out = await apply([tx, good])
            expect(out.failedTxs).toEqual([tx.hash])
            expect(out.successfulTxs).toEqual([good.hash])
        })
    }

    it("a tlsnotary edit without data fails its transaction", async () => {
        const tx = await sendTo(PEER)
        ;(tx.content.gcr_edits as unknown[]).push({ type: "tlsnotary", operation: "add", account: PEER })
        const out = await apply([tx])
        expect(out.failedTxs).toEqual([tx.hash])
    })

    it("is judged by the rule createAccount applies", async () => {
        for (const key of [PEER, PEER.slice(2), "0x1234", "   ", "", " ".repeat(64), "z".repeat(64), withLast("\u0000")]) {
            const refused = uncreatableAccountKey(key) !== null
            const threw = await HandleGCR.createAccount(key, {}, true).then(() => false, () => true)
            expect(`${JSON.stringify(key)} ${refused}`).toBe(`${JSON.stringify(key)} ${threw}`)
        }
    })
})

describe("the row a balance edit leaves", () => {
    it("is judged by its key, which no check binds to a shape", async () => {
        const key = withLast("\u0000")
        const entities: any = {
            accounts: new Map([[key, Object.assign(new GCRMain(), { pubkey: key, balance: 0n, nonce: 0 })]]),
            storagePrograms: new Map(),
            tlsNotaries: new Map(),
            atomicWorks: new Map(),
            resourceSlots: new Map(),
        }
        const result = await HandleGCR.applyStorableEdit(
            { type: "balance", operation: "add", account: key, amount: 1, isRollback: false, txhash: "" } as never,
            entities,
        )
        expect(result.success).toBe(false)
        expect(result.message).toContain("accounts.pubkey")
    })
})
