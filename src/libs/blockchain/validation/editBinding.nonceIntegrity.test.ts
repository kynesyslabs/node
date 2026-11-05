/**
 * The nonce edit at gossip ingest, consensus merge and RPC intake. Before
 * `editBinding`, a type other than native, identity and Work is only checked
 * for value edits nobody derived, so a forged nonce edit rode along. Under
 * `nonceIntegrity` the nonce edit is bound on every type, on either side of
 * `editBinding`.
 *
 * Each transaction is built and signed by the real SDK, then has its shipped
 * edits changed the way a peer with its own key could change them.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"

let tip = 100
mock.module("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: { getLastBlockNumber: async () => tip },
}))
mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: () => {},
        info: () => {},
        warning: () => {},
        error: () => {},
        only: () => {},
    },
}))

import { DemosTransactions } from "@kynesyslabs/demosdk/websdk"
import { StorageProgram } from "@kynesyslabs/demosdk/storage"
import type { Transaction } from "@kynesyslabs/demosdk/types"
import { getSharedState } from "@/utilities/sharedState"
import type { ForkConfigByName } from "@/forks/forkConfig"
import {
    editBindingState,
    expectsNonceEdit,
    verifyAdmissionEdits,
    verifyNonceEditBinding,
    verifyRpcEdits,
} from "./editBinding"
import { OS, PEER, SENDER, VICTIM, chainIs, demos, handMade, onTheWire } from "./editBinding.fixtures"

let savedForks: ForkConfigByName

/** editBinding as given, nonceIntegrity active from `nonceIntegrity` (null: dormant). */
function chain(nonceIntegrity: number | null, editBinding: number | null = null) {
    chainIs(true, editBinding)
    getSharedState.forkConfig.nonceIntegrity.activationHeight = nonceIntegrity
    tip = 100
}

const edits = (tx: Transaction) => tx.content.gcr_edits as unknown as Array<Record<string, any>>
const nonceEdit = (tx: Transaction) => edits(tx).find(e => e.type === "nonce")!

const contractCall = async () =>
    onTheWire(await handMade("contractCall", { contractAddress: PEER, method: "get", args: [] }))
const nativeSend = async () => onTheWire(await DemosTransactions.pay(PEER, 3n * OS, demos))
/** The write the devnet run sends to a program that does not exist, so it fails in the block. */
const storageWrite = async () =>
    onTheWire(await demos.storagePrograms.sign(StorageProgram.writeStorage("stor-" + "ab".repeat(20), { a: 2 }, "json")))

const forgeries: Array<[string, (tx: Transaction) => void]> = [
    ["bumps by more than one", tx => { nonceEdit(tx).amount = 1000 }],
    ["bumps another account", tx => { nonceEdit(tx).account = VICTIM }],
    ["ships a rollback flag", tx => { nonceEdit(tx).isRollback = true }],
    ["removes instead of adding", tx => { nonceEdit(tx).operation = "remove" }],
    ["is shipped twice", tx => { edits(tx).push({ ...nonceEdit(tx) }) }],
    ["is missing", tx => { tx.content.gcr_edits = edits(tx).filter(e => e.type !== "nonce") as never }],
    ["carries an unexpected field", tx => { nonceEdit(tx).extra = 1 }],
    ["names an amount as a string", tx => { nonceEdit(tx).amount = "1" }],
]

beforeEach(() => {
    savedForks = getSharedState.forkConfig
})

afterEach(() => {
    getSharedState.forkConfig = savedForks
})

describe("the nonce edit an SDK-built transaction ships", () => {
    it("is exactly one +1 on the sender, for each builder", async () => {
        for (const tx of [await contractCall(), await nativeSend(), await storageWrite()]) {
            const nonces = edits(tx).filter(e => e.type === "nonce")
            expect(nonces).toHaveLength(1)
            expect(nonces[0]).toMatchObject({ operation: "add", account: SENDER, amount: 1, isRollback: false })
            expect(verifyNonceEditBinding(tx)).toEqual({ ok: true })
        }
    })
})

describe("gossip and merge admission with editBinding dormant", () => {
    it("lets a forged nonce edit on a projection-checked type through before nonceIntegrity", async () => {
        chain(null)
        const tx = await contractCall()
        nonceEdit(tx).amount = 1000

        expect((await editBindingState()).nonceBound).toBe(false)
        expect(await verifyAdmissionEdits(tx)).toEqual({ ok: true })
        expect(await verifyRpcEdits(tx)).toEqual({ ok: true })
    })

    describe("under nonceIntegrity", () => {
        beforeEach(() => chain(0))

        it("admits the honest transaction", async () => {
            expect(await verifyAdmissionEdits(await contractCall())).toEqual({ ok: true })
            expect(await verifyAdmissionEdits(await nativeSend())).toEqual({ ok: true })
            expect(await verifyAdmissionEdits(await storageWrite())).toEqual({ ok: true })
            expect(await verifyRpcEdits(await contractCall())).toEqual({ ok: true })
        })

        for (const [name, forge] of forgeries) {
            it(`refuses a nonce edit that ${name}`, async () => {
                const tx = await contractCall()
                forge(tx)
                expect((await verifyAdmissionEdits(tx)).ok).toBe(false)
                expect((await verifyRpcEdits(tx)).ok).toBe(false)
            })
        }

        it("refuses a forged nonce edit on a native transfer too", async () => {
            const tx = await nativeSend()
            nonceEdit(tx).account = VICTIM
            expect((await verifyAdmissionEdits(tx)).ok).toBe(false)
        })

        it("refuses a transaction whose nonce is not a positive integer", async () => {
            const tx = await contractCall()
            tx.content.nonce = 0
            expect((await verifyAdmissionEdits(tx)).ok).toBe(false)
            tx.content.nonce = 1.5
            expect((await verifyAdmissionEdits(tx)).ok).toBe(false)
        })

        it("binds from the block applied on tip H, which is block H + 1", async () => {
            chain(101)
            const tx = await contractCall()
            nonceEdit(tx).amount = 1000
            expect((await verifyAdmissionEdits(tx)).ok).toBe(true)
            tip = 101
            expect((await verifyAdmissionEdits(tx)).ok).toBe(false)
        })
    })
})

describe("gossip and merge admission with editBinding active", () => {
    beforeEach(() => chain(0, 0))

    it("admits the honest transaction", async () => {
        expect(await verifyAdmissionEdits(await contractCall())).toEqual({ ok: true })
    })

    for (const [name, forge] of forgeries) {
        it(`refuses a nonce edit that ${name}`, async () => {
            const tx = await contractCall()
            forge(tx)
            expect((await verifyAdmissionEdits(tx)).ok).toBe(false)
        })
    }
})

describe("transactions that spend no nonce", () => {
    beforeEach(() => chain(0))

    it("are the edit-free relay types, the node's own messages and the incentive award", () => {
        const of = (content: Record<string, unknown>) => ({ hash: "ab".repeat(32), content }) as unknown as Transaction
        expect(expectsNonceEdit(of({ type: "l2psBatch", gcr_edits: [] }))).toBe(false)
        expect(expectsNonceEdit(of({ type: "genesis", gcr_edits: [] }))).toBe(false)
        expect(expectsNonceEdit(of({ type: "instantMessaging", gcr_edits: [] }))).toBe(false)
        expect(expectsNonceEdit(of({ type: "identity", data: ["awardPoints", []], gcr_edits: [] }))).toBe(false)
        expect(expectsNonceEdit(of({ type: "instantMessaging", gcr_edits: [{ type: "nonce" }] }))).toBe(true)
        expect(expectsNonceEdit(of({ type: "native", gcr_edits: [] }))).toBe(true)
    })

    it("may not ship one", () => {
        const tx = {
            hash: "ab".repeat(32),
            content: {
                type: "l2psBatch",
                from: SENDER,
                nonce: 1,
                gcr_edits: [{ type: "nonce", operation: "add", account: SENDER, amount: 1, isRollback: false, txhash: "" }],
            },
        } as unknown as Transaction
        expect(verifyNonceEditBinding(tx).ok).toBe(false)
    })
})
