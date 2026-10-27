/**
 * A peer that signs its own transactions can ship any edits with them. Both
 * doors into the pool, gossip ingest and the consensus mempool merge, must
 * refuse the edit kinds that used to slip through for non-native types, and
 * must still admit what the SDK builds.
 *
 * The edit binding, the SDK and its serialiser are the real ones; only the
 * pool's storage and the chain are replaced.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test"

let inserted: Array<Record<string, unknown>> = []
const logged: string[] = []

mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: () => {},
        info: () => {},
        warning: () => {},
        error: (m: unknown) => logged.push(String(m)),
        only: () => {},
        custom: () => {},
    },
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
mock.module("src/libs/blockchain/validation/txValidatorPool", () => ({
    __esModule: true,
    default: {
        getInstance: () => ({
            validate: async (txs: Array<{ hash: string }>) => txs.map(t => ({ valid: true, hash: t.hash })),
        }),
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
mock.module("./validation/txAdmission", () => ({
    checkTxAdmissible: async () => ({ ok: true }),
}))

import { StorageProgram } from "@kynesyslabs/demosdk/storage"
import { DemosTransactions } from "@kynesyslabs/demosdk/websdk"
import { Identities } from "@kynesyslabs/demosdk/abstraction"
import type { Transaction, ValidityData } from "@kynesyslabs/demosdk/types"
import Mempool from "./mempool"
import { OS, PEER, SENDER, VICTIM, chainIs, demos, onTheWire, viaConfirm } from "./validation/editBinding.fixtures"

const identities = new Identities()
const storageAddress = StorageProgram.createStorageProgram(SENDER, "probe", { a: 1 }, "json", undefined, { nonce: 1 }).storageAddress

const builders: Record<string, () => Promise<Transaction>> = {
    storageWrite: () => demos.storagePrograms.sign(StorageProgram.writeStorage(storageAddress, { a: 2 }, "json")),
    unstake: () => DemosTransactions.unstake(demos),
    vote: () => DemosTransactions.voteOnUpgrade("11111111-1111-4111-8111-111111111111", true, demos),
    identity: () =>
        viaConfirm(() =>
            identities.inferXmIdentity(
                demos,
                {
                    target_identity: {
                        chain: "evm",
                        subchain: "mainnet",
                        isEVM: true,
                        chainId: 1,
                        targetAddress: "0x" + "ee".repeat(20),
                        signature: "0x12",
                        publicKey: "0x34",
                    },
                } as never,
                "ref1",
            ),
        ),
}

type Forgery = [name: string, base: keyof typeof builders, tamper: (edits: Array<Record<string, any>>) => void]

const forgeries: Forgery[] = [
    ["a nonce bump on another account", "unstake", e => e.push({ type: "nonce", operation: "add", account: VICTIM, amount: 1000, isRollback: false, txhash: "" })],
    ["a vote under another validator", "vote", e => (e.find(x => x.type === "networkUpgradeVote")!.account = VICTIM)],
    ["a storage write naming another sender", "storageWrite", e => (e.find(x => x.type === "storageProgram")!.context.sender = VICTIM)],
    ["an identity attached to another account", "identity", e => (e.find(x => x.type === "identity")!.account = VICTIM)],
    [
        "a points credit",
        "storageWrite",
        e => e.push({ type: "identity", context: "points", isRollback: false, operation: "add", account: SENDER, amount: 1_000_000, date: new Date().toISOString(), txhash: "" }),
    ],
    ["a balance credit", "unstake", e => e.push({ type: "balance", operation: "add", account: SENDER, amount: String(1_000_000n * OS), isRollback: false, txhash: "" })],
]

async function forged(base: keyof typeof builders, tamper: Forgery[2]): Promise<Transaction> {
    const tx = onTheWire(await builders[base]())
    tamper(tx.content.gcr_edits as unknown as Array<Record<string, any>>)
    return tx
}

const validity = (tx: Transaction): ValidityData =>
    ({ data: { transaction: tx, reference_block: 100 } }) as unknown as ValidityData

beforeEach(() => {
    chainIs(true)
    inserted = []
    logged.length = 0
    ;(Mempool as any).repo = { find: async () => [] }
    ;(Mempool as any).addTransactionWithLock = async () => ({ confirmationBlock: 101 })
})

describe("Mempool.ingestGossiped", () => {
    for (const name of Object.keys(builders)) {
        it(`admits an unmodified ${name} transaction`, async () => {
            const tx = onTheWire(await builders[name]())
            expect(await Mempool.ingestGossiped(validity(tx))).toMatchObject({ accepted: true })
        })
    }

    for (const [name, base, tamper] of forgeries) {
        it(`refuses ${name}`, async () => {
            const tx = await forged(base, tamper)
            const out = await Mempool.ingestGossiped(validity(tx))
            expect(out.accepted).toBe(false)
            expect(out.reason).toContain("gcr_edits")
        })
    }
})

describe("Mempool.receive", () => {
    const row = (tx: Transaction) => ({ ...tx, reference_block: 100, blockNumber: 100, status: "pending" }) as unknown as Transaction

    for (const name of Object.keys(builders)) {
        it(`admits an unmodified ${name} transaction`, async () => {
            const tx = onTheWire(await builders[name]())
            await Mempool.receive([row(tx)], false)
            expect(inserted.map(r => r.hash)).toEqual([tx.hash])
        })
    }

    for (const [name, base, tamper] of forgeries) {
        it(`refuses ${name}`, async () => {
            const tx = await forged(base, tamper)
            await Mempool.receive([row(tx)], false)
            expect(inserted).toHaveLength(0)
            expect(logged.some(m => m.includes(`Rejecting tx ${tx.hash}`))).toBe(true)
        })
    }

    it("admits the honest transactions of a batch that also holds a forgery", async () => {
        const honest = onTheWire(await builders.unstake())
        const bad = await forged("vote", forgeries[1][2])
        await Mempool.receive([row(bad), row(honest)], false)
        expect(inserted.map(r => r.hash)).toEqual([honest.hash])
    })
})
