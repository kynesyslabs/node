/**
 * A granular storage write as a client builds it, received by a peer, checked
 * by the edit binding and applied: the shipped edits must be the ones the node
 * regenerates, and the fee the node records must be the one the transaction
 * burns.
 *
 * Regeneration runs through the SDK the node is built with. Until the node
 * ships an SDK that emits the granular edits, point GRANULAR_SDK_BUILD at a
 * built SDK (its `build/` directory) to run these cases against it; with an
 * SDK that emits none they are skipped.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test"

mock.module("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: { getLastBlockNumber: async () => 100 },
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
const fakeDataSource = { getRepository: () => ({}) }
const datasourceModule = () => ({
    __esModule: true,
    dataSource: fakeDataSource,
    default: { getInstance: async () => ({ getDataSource: () => fakeDataSource }) },
})
mock.module("src/model/datasource", datasourceModule)
mock.module("@/model/datasource", datasourceModule)

import { denomination } from "@kynesyslabs/demosdk"
import { StorageProgram } from "@kynesyslabs/demosdk/storage"
import type { GCREdit, Transaction } from "@kynesyslabs/demosdk/types"
import { cloneDefaultForkConfig } from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"
import { GCRStorageProgram } from "@/model/entities/GCRv2/GCR_StorageProgram"

const sdkBuild = process.env.GRANULAR_SDK_BUILD
const { GCRGeneration } = sdkBuild
    ? await import(`${sdkBuild}/websdk/GCRGeneration.js`)
    : await import("@kynesyslabs/demosdk/websdk")

const realGeneration = await import("./generateGcrEdits")
mock.module("./generateGcrEdits", () => ({
    ...realGeneration,
    generateGcrEdits: (tx: Transaction) => GCRGeneration.generate(tx),
}))

const { verifyEditsAtApply } = await import("./editBinding")
const { default: HandleGCR, normalizePubkey } = await import(
    "@/libs/blockchain/gcr/handleGCR"
)

const SENDER = "0x" + "ab".repeat(32)
const OTHER = "0x" + "cd".repeat(32)
const ADDRESS = "stor-" + "ef".repeat(20)

function storageTx(payload: unknown, nonce = 8): Transaction {
    return {
        hash: "",
        content: {
            type: "storageProgram",
            from: SENDER,
            from_ed25519_address: SENDER,
            to: ADDRESS,
            amount: 0,
            data: ["storageProgram", payload],
            gcr_edits: [],
            nonce,
            timestamp: 1_700_000_000_000,
            transaction_fee: {
                network_fee: 0,
                rpc_fee: 0,
                additional_fee: 0,
                rpc_address: null,
            },
        },
    } as unknown as Transaction
}

/** What a peer receives: the author's tx after the SDK wire serialisation. */
function onTheWire(tx: Transaction, postFork: boolean): Transaction {
    const copy = JSON.parse(JSON.stringify(tx)) as Transaction
    copy.content = JSON.parse(
        denomination.serializeTransactionContent(copy.content as any, postFork),
    )
    copy.hash = "de".repeat(32)
    return copy
}

async function authored(payload: unknown, postFork: boolean): Promise<Transaction> {
    const tx = storageTx(payload)
    tx.content.gcr_edits = await GCRGeneration.generate(tx)
    return onTheWire(tx, postFork)
}

function chainIs(postFork: boolean) {
    getSharedState.forkConfig = cloneDefaultForkConfig()
    getSharedState.forkConfig.osDenomination.activationHeight = postFork ? 0 : null
    getSharedState.forkConfig.editBinding.activationHeight = 0
    getSharedState.lastBlockNumber = 100
}

const payloads = {
    SET_FIELD: StorageProgram.setField(ADDRESS, "n", 2),
    SET_ITEM: StorageProgram.setItem(ADDRESS, "list", -1, { done: true }),
    APPEND_ITEM: StorageProgram.appendItem(ADDRESS, "list", "x".repeat(15000)),
    DELETE_FIELD: StorageProgram.deleteField(ADDRESS, "n"),
    DELETE_ITEM: StorageProgram.deleteItem(ADDRESS, "list", 0),
}

const emitsGranular = (
    (await GCRGeneration.generate(storageTx(payloads.SET_FIELD))) as GCREdit[]
).some(e => e.type === "storageProgram")

const storageEdit = (tx: Transaction) =>
    tx.content.gcr_edits.find(e => e.type === "storageProgram") as any

describe.skipIf(!emitsGranular)("granular storage writes on the wire", () => {
    for (const postFork of [false, true]) {
        describe(postFork ? "post osDenomination" : "pre osDenomination", () => {
            beforeEach(() => chainIs(postFork))

            for (const [operation, payload] of Object.entries(payloads)) {
                it(`${operation} as built by the client is bound`, async () => {
                    const tx = await authored(payload, postFork)
                    expect(storageEdit(tx).context.operation).toBe(operation)
                    expect(await verifyEditsAtApply(tx, { postFork })).toEqual({ ok: true })
                })
            }

            it("refuses a write that ships no storage fee", async () => {
                const tx = await authored(payloads.SET_FIELD, postFork)
                tx.content.gcr_edits = tx.content.gcr_edits.slice(1)
                expect((await verifyEditsAtApply(tx, { postFork })).ok).toBe(false)
            })

            it("refuses a write that ships a smaller storage fee", async () => {
                const tx = await authored(payloads.APPEND_ITEM, postFork)
                const burn = tx.content.gcr_edits[0] as any
                burn.amount = postFork ? "1000000000" : 1
                expect((await verifyEditsAtApply(tx, { postFork })).ok).toBe(false)
            })

            it("refuses a storage edit that names another sender", async () => {
                const tx = await authored(payloads.SET_FIELD, postFork)
                storageEdit(tx).context.sender = OTHER
                expect((await verifyEditsAtApply(tx, { postFork })).ok).toBe(false)
            })

            it("refuses a value changed after signing", async () => {
                const tx = await authored(payloads.SET_FIELD, postFork)
                storageEdit(tx).context.data.variables.value = 3
                expect((await verifyEditsAtApply(tx, { postFork })).ok).toBe(false)
            })

            it("refuses the edit-less form older clients ship", async () => {
                const tx = await authored(payloads.SET_FIELD, postFork)
                // Only the universal gas and nonce edits
                tx.content.gcr_edits = tx.content.gcr_edits.slice(-2)
                expect((await verifyEditsAtApply(tx, { postFork })).ok).toBe(false)
            })
        })
    }

    describe("applied", () => {
        const START = 1_000_000_000_000n

        async function caches(): Promise<any> {
            const account = await HandleGCR.createAccount(SENDER, { balance: START }, true)
            const program = new GCRStorageProgram()
            Object.assign(program, {
                storageAddress: ADDRESS,
                owner: SENDER,
                programName: "probe",
                encoding: "json",
                data: { n: 1, list: ["a"] },
                sizeBytes: Buffer.byteLength(JSON.stringify({ n: 1, list: ["a"] })),
                acl: { mode: "owner" },
                metadata: null,
                storageLocation: "onchain",
                ipfsCid: null,
                salt: null,
                createdByTx: "tx_create",
                lastModifiedByTx: "tx_create",
                interactionTxs: ["tx_create"],
                totalFeesPaid: 1n,
                isDeleted: false,
                deletedByTx: null,
            })
            return {
                accounts: new Map([[normalizePubkey(SENDER), account]]),
                storagePrograms: new Map([[ADDRESS, program]]),
                tlsNotaries: new Map(),
                atomicWorks: new Map(),
                resourceSlots: new Map(),
            }
        }

        const burned = (tx: Transaction) =>
            tx.content.gcr_edits
                .filter(e => e.type === "balance")
                .reduce((sum, e) => sum + BigInt((e as any).amount), 0n)

        beforeEach(() => chainIs(true))

        it("changes the data and records the fee the transaction burns", async () => {
            const tx = await authored(payloads.APPEND_ITEM, true)
            expect(await verifyEditsAtApply(tx, { postFork: true })).toEqual({ ok: true })

            const entities = await caches()
            const result = await HandleGCR.applyTransaction(entities, tx, false, false)
            expect(result.success).toBe(true)

            const program = entities.storagePrograms.get(ADDRESS)
            expect(program.data).toEqual({ n: 1, list: ["a", "x".repeat(15000)] })
            expect(program.lastModifiedByTx).toBe(tx.hash)
            expect(program.sizeBytes).toBe(Buffer.byteLength(JSON.stringify(program.data)))

            const storageBurn = BigInt((tx.content.gcr_edits[0] as any).amount)
            expect(storageBurn).toBe(2n * 1_000_000_000n)
            // The node books storage fees in DEM
            expect(program.totalFeesPaid).toBe(1n + storageBurn / 1_000_000_000n)
            expect(entities.accounts.get(normalizePubkey(SENDER)).balance).toBe(START - burned(tx))
        })

        it("simulating leaves the stored data as it was", async () => {
            const tx = await authored(payloads.SET_FIELD, true)
            const entities = await caches()
            const before = structuredClone({ ...entities.storagePrograms.get(ADDRESS) })
            const result = await HandleGCR.applyTransaction(entities, tx, false, true)
            expect(result.success).toBe(true)
            expect({ ...entities.storagePrograms.get(ADDRESS) }).toEqual(before)
        })

        it("a refused write charges nothing and leaves the data as it was", async () => {
            const tx = await authored(StorageProgram.setItem(ADDRESS, "n", 0, 1), true)
            const entities = await caches()
            const before = structuredClone({ ...entities.storagePrograms.get(ADDRESS) })
            const result = await HandleGCR.applyTransaction(entities, tx, false, false)
            expect(result.success).toBe(false)
            expect({ ...entities.storagePrograms.get(ADDRESS) }).toEqual(before)
            expect(entities.accounts.get(normalizePubkey(SENDER)).balance).toBe(START)
        })
    })
})
