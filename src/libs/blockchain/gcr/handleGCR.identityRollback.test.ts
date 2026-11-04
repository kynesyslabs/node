/**
 * A block's identity edits undo cleanly: the rollback a node runs on GCR
 * state left behind without its block puts every link back as it was, and a
 * transaction that fails after its identity edit applied keeps nothing of it.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"

mock.module("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: {
        getLastBlockNumber: async () => 100,
        getExistingTransactionHashes: async () => new Set<string>(),
    },
}))
mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: () => {},
        info: () => {},
        warning: () => {},
        warn: () => {},
        error: () => {},
        only: () => {},
        custom: () => {},
    },
}))

import type { Transaction } from "@kynesyslabs/demosdk/types"
import { cloneDefaultForkConfig, type ForkConfigByName } from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"
import Hashing from "@/libs/crypto/hashing"
import type { GCREntityCaches } from "./handleGCR"

const { default: HandleGCR } = await import("./handleGCR")

const SENDER = "0x" + "5e".repeat(32)
const PROOF = "https://x.com/alice/status/1"
const EVM_ADDR = "0x" + "aa".repeat(20)

let caches: GCREntityCaches
let applies: GCREntityCaches[]
let savedForks: ForkConfigByName
let savedTip: number
const original = {
    prepareEntities: HandleGCR.prepareEntities,
    saveGCREditChanges: HandleGCR.saveGCREditChanges,
    bulkUpdateAssignedTxs: HandleGCR.bulkUpdateAssignedTxs,
}

function linkedAccount(): any {
    return {
        pubkey: SENDER,
        balance: 1_000n,
        nonce: 3,
        identities: {
            xm: {
                evm: {
                    mainnet: [
                        {
                            address: EVM_ADDR,
                            signature: "0xsig",
                            publicKey: "",
                            timestamp: 1,
                            signedData: "signed",
                        },
                    ],
                },
            },
            web2: {
                twitter: [
                    {
                        username: "carol",
                        userId: "7",
                        proof: "https://x.com/carol/status/7",
                        proofHash: "h7",
                        timestamp: 1,
                    },
                ],
            },
            pqc: {},
            ud: [],
        },
    }
}

const account = () => caches.accounts.get(SENDER) as any

let seq = 0
function identityTx(context: string, operation: string, data: unknown): Transaction {
    const hash = (++seq).toString(16).padStart(64, "0")
    return {
        hash,
        blockNumber: 101,
        content: {
            type: "identity",
            from: SENDER,
            from_ed25519_address: SENDER,
            to: SENDER,
            amount: 0,
            nonce: 4,
            timestamp: 1,
            data: ["identity", {}],
            gcr_edits: [
                { type: "nonce", operation: "add", account: SENDER, amount: 1, isRollback: false, txhash: hash },
                {
                    type: "identity",
                    operation,
                    context,
                    account: SENDER,
                    txhash: hash,
                    isRollback: false,
                    referralCode: null,
                    data,
                },
            ],
        },
    } as unknown as Transaction
}

const web2Add = () =>
    identityTx("web2", "add", {
        context: "twitter",
        data: { username: "alice", userId: "42", proof: PROOF, proofHash: Hashing.sha256(PROOF), timestamp: 5 },
    })
const web2Remove = () => identityTx("web2", "remove", { context: "twitter", username: "carol" })
const xmAdd = () =>
    identityTx("xm", "add", {
        chain: "evm",
        subchain: "mainnet",
        isEVM: true,
        chainId: 1,
        targetAddress: "0x" + "BB".repeat(20),
        signature: "0xsig-b",
        signedData: "signed",
        publicKey: "",
        timestamp: 5,
    })
const xmRemove = () =>
    identityTx("xm", "remove", {
        chain: "evm",
        subchain: "mainnet",
        isEVM: true,
        targetAddress: EVM_ADDR.toUpperCase().replace("0X", "0x"),
    })

beforeEach(() => {
    savedForks = getSharedState.forkConfig
    savedTip = getSharedState.lastBlockNumber
    getSharedState.forkConfig = cloneDefaultForkConfig()
    getSharedState.forkConfig.nonceEnforcement.activationHeight = null
    getSharedState.forkConfig.gasFeeSeparation.activationHeight = null
    getSharedState.forkConfig.editBinding.activationHeight = null
    getSharedState.lastBlockNumber = 100
    caches = {
        accounts: new Map([[SENDER, linkedAccount()]]),
        storagePrograms: new Map(),
        tlsNotaries: new Map(),
        atomicWorks: new Map(),
        resourceSlots: new Map(),
    } as GCREntityCaches
    applies = []
    // Each apply gets its own caches over the same rows, as from the database.
    ;(HandleGCR as any).prepareEntities = async () => {
        const set = { ...caches }
        applies.push(set)
        return set
    }
    ;(HandleGCR as any).saveGCREditChanges = async () => {}
    ;(HandleGCR as any).bulkUpdateAssignedTxs = async () => {}
})

afterEach(() => {
    getSharedState.forkConfig = savedForks
    getSharedState.lastBlockNumber = savedTip
    Object.assign(HandleGCR, original)
})

describe("rolling back a block's identity transactions in a later apply", () => {
    for (const [name, make] of [
        ["web2 link", web2Add],
        ["cross-chain link", xmAdd],
    ] as const) {
        it(`restores the account after a ${name}`, async () => {
            const before = structuredClone(account())
            const tx = make()

            const applied = await HandleGCR.applyTransactions([tx], false)
            expect(applied.failedTxs).toEqual([])
            expect(account().identities).not.toEqual(before.identities)

            const undone = await HandleGCR.applyTransactions([tx], true)

            expect(undone.failedTxs).toEqual([])
            expect(undone.successfulTxs).toEqual([tx.hash])
            expect(account()).toEqual(before)
        })
    }

    // What an unlink removed is recorded only for the apply that ran it.
    for (const [name, make] of [
        ["web2 unlink", web2Remove],
        ["cross-chain unlink", xmRemove],
    ] as const) {
        it(`fails after a ${name}, changing nothing`, async () => {
            const tx = make()
            expect((await HandleGCR.applyTransactions([tx], false)).failedTxs).toEqual([])
            const after = structuredClone(account())

            const undone = await HandleGCR.applyTransactions([tx], true)

            expect(undone.failedTxs).toEqual([tx.hash])
            expect(account()).toEqual(after)
        })
    }
})

describe("undo records of an unlink", () => {
    it("are kept by a block apply, in that apply's caches only", async () => {
        await HandleGCR.applyTransactions([web2Remove()], false)

        expect(applies).toHaveLength(1)
        expect(applies[0].removedIdentities?.size).toBe(1)
        expect(caches.removedIdentities).toBeUndefined()
    })

    it("are not written by a simulation, whatever txhash its edits carry", async () => {
        for (const make of [web2Remove, xmRemove]) {
            const set = { ...caches }
            const result = await HandleGCR.applyTransaction(set, make(), false, true)

            expect(result.success).toBe(true)
            expect(set.removedIdentities?.size ?? 0).toBe(0)
        }
    })
})

describe("a transaction that fails after its identity edit applied", () => {
    /** A write to a storage program that does not exist always fails. */
    const failingWrite = (hash: string) => ({
        type: "storageProgram",
        target: "stor-" + "00".repeat(20),
        isRollback: false,
        txhash: hash,
        context: {
            operation: "WRITE_STORAGE",
            sender: SENDER,
            data: { variables: { k: "v" } },
        },
    })

    for (const [name, make] of [
        ["web2 link", web2Add],
        ["web2 unlink", web2Remove],
        ["cross-chain link", xmAdd],
        ["cross-chain unlink", xmRemove],
    ] as const) {
        it(`keeps nothing of a ${name}, charges nothing and leaves its edits as signed`, async () => {
            const before = structuredClone(account())
            const tx = make()
            const edits = tx.content.gcr_edits as any[]
            edits.unshift({ type: "balance", operation: "remove", account: SENDER, amount: 10, isRollback: false, txhash: tx.hash })
            edits.push(failingWrite(tx.hash))
            const signed = structuredClone(edits)

            const out = await HandleGCR.applyTransactions([tx], false)

            expect(out.failedTxs).toEqual([tx.hash])
            expect(account()).toEqual(before)
            expect(tx.content.gcr_edits).toEqual(signed)
        })
    }
})

describe("a transaction whose identity edit fails after a stored proof", () => {
    it("keeps no proof row", async () => {
        const tx = web2Add()
        const edits = tx.content.gcr_edits as any[]
        edits[1].data.data.proofHash = "not the hash of the proof"
        edits.splice(1, 0, {
            type: "tlsnotary",
            operation: "store",
            account: SENDER,
            txhash: tx.hash,
            isRollback: false,
            data: { tokenId: "token-1", domain: "x.com", proof: "p", storageType: "onchain", timestamp: 1 },
        })

        const out = await HandleGCR.applyTransactions([tx], false)

        expect(out.failedTxs).toEqual([tx.hash])
        expect(caches.tlsNotaries.has("token-1")).toBe(false)
    })
})
