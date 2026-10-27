/**
 * The value-edit guard compares what a non-native transaction ships against
 * what the node regenerates for it. On the wire the SDK serialises amounts
 * as OS strings once osDenomination is active, while regeneration yields the
 * author shape, so the two must meet in one shape or every legitimate
 * storage write is refused by every node except the one that received it.
 * These cases use the real SDK builders and the real serialiser, pre- and
 * post-fork, and check that a shipped amount is only ever accepted exactly
 * as it will be applied.
 */

import { describe, it, expect, beforeAll, mock } from "bun:test"

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

import { GCRGeneration } from "@kynesyslabs/demosdk/websdk"
import { denomination } from "@kynesyslabs/demosdk"
import { StorageProgram } from "@kynesyslabs/demosdk/storage"
import type { GCREdit, Transaction } from "@kynesyslabs/demosdk/types"
import { cloneDefaultForkConfig } from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"
import { verifyNoUnexplainedValueEdits } from "./verifyGcrEdits"

const SENDER = "0x" + "ab".repeat(32)

function storageTx(payload: unknown, to: string, nonce: number): Transaction {
    return {
        hash: "",
        content: {
            type: "storageProgram",
            from: SENDER,
            from_ed25519_address: SENDER,
            to,
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

async function authored(payload: unknown, to: string, nonce: number) {
    const tx = storageTx(payload, to, nonce)
    tx.content.gcr_edits = await GCRGeneration.generate(tx)
    return tx
}

const create = StorageProgram.createStorageProgram(
    SENDER,
    "probe",
    { hello: "world" },
    "json",
    undefined,
    { nonce: 1 },
)
const address = create.storageAddress
const cases: Array<[string, unknown]> = [
    ["create", create],
    ["write", StorageProgram.writeStorage(address, { hello: "again" }, "json")],
    [
        "access control",
        StorageProgram.updateAccessControl(address, StorageProgram.publicACL()),
    ],
]

function withOsDenominationAt(height: number | null) {
    getSharedState.forkConfig = cloneDefaultForkConfig()
    getSharedState.forkConfig.osDenomination.activationHeight = height
}

describe("verifyNoUnexplainedValueEdits on SDK-built storage transactions", () => {
    beforeAll(() => {
        getSharedState.lastBlockNumber = 100
    })

    for (const [name, payload] of cases) {
        it(`accepts a ${name} as received after the fork`, async () => {
            withOsDenominationAt(0)
            const tx = await authored(payload, address, 2)
            const shipped = (tx.content.gcr_edits as GCREdit[]).filter(
                e => (e as any).type === "balance",
            )
            // The builder charges the storage fee, so there is a value edit to explain.
            expect(shipped.length).toBeGreaterThan(0)

            const result = await verifyNoUnexplainedValueEdits(onTheWire(tx, true))
            expect(result).toEqual({ ok: true, unexplained: [] })
        })

        it(`accepts a ${name} as received before the fork`, async () => {
            withOsDenominationAt(null)
            const tx = await authored(payload, address, 2)
            const result = await verifyNoUnexplainedValueEdits(onTheWire(tx, false))
            expect(result).toEqual({ ok: true, unexplained: [] })
        })
    }

    it("still rejects a balance the node would not generate, in wire shape", async () => {
        withOsDenominationAt(0)
        const tx = await authored(create, address, 2)
        ;(tx.content.gcr_edits as GCREdit[]).push({
            type: "balance",
            operation: "add",
            account: SENDER,
            amount: 1_000_000_000_000,
            isRollback: false,
            txhash: "",
        } as unknown as GCREdit)

        const result = await verifyNoUnexplainedValueEdits(onTheWire(tx, true))
        expect(result.ok).toBe(false)
        expect(result.unexplained).toHaveLength(1)
        expect(result.unexplained[0]).toContain("balance|" + SENDER + "|add|")
    })

    it("still rejects a fee edit whose amount was tampered with", async () => {
        withOsDenominationAt(0)
        const tx = await authored(create, address, 2)
        const fee = feeEdit(tx)
        fee.amount = 7

        const result = await verifyNoUnexplainedValueEdits(onTheWire(tx, true))
        expect(result.ok).toBe(false)
    })

    it("rejects a fee shipped as a number after the fork, which would be applied as 1 OS", async () => {
        withOsDenominationAt(0)
        const tx = await authored(create, address, 2)
        const wire = onTheWire(tx, true)
        // The author shape: the fee in DEM. Applied raw this pays one OS unit.
        feeEdit(wire).amount = 1

        const result = await verifyNoUnexplainedValueEdits(wire)
        expect(result.ok).toBe(false)
    })

    it("rejects a fee shipped as an OS string before the fork, which would be applied in full", async () => {
        withOsDenominationAt(null)
        const tx = await authored(create, address, 2)
        const wire = onTheWire(tx, false)
        // Reinterpreted as DEM this would equal the regenerated fee of 1,
        // but the balance routine removes 1000000000.
        feeEdit(wire).amount = "1000000000"

        const result = await verifyNoUnexplainedValueEdits(wire)
        expect(result.ok).toBe(false)
    })

    for (const bad of ["abc", "", -1, { os: "1" }, null, 1.5]) {
        it(`refuses, without throwing, a shipped amount of ${JSON.stringify(bad)}`, async () => {
            withOsDenominationAt(0)
            const tx = await authored(create, address, 2)
            const wire = onTheWire(tx, true)
            feeEdit(wire).amount = bad

            const result = await verifyNoUnexplainedValueEdits(wire)
            expect(result.ok).toBe(false)
        })
    }

    it("answers, without throwing, for a transaction whose fee field is missing", async () => {
        withOsDenominationAt(0)
        const tx = await authored(create, address, 2)
        const wire = onTheWire(tx, true)
        delete (wire.content as any).transaction_fee

        // The fee field itself is the validator's business; the edits are
        // still exactly the ones the node generates.
        const result = await verifyNoUnexplainedValueEdits(wire)
        expect(result.ok).toBe(true)
    })
})

function feeEdit(tx: Transaction): any {
    const edit = (tx.content.gcr_edits as GCREdit[]).find(
        e => (e as any).type === "balance" && (e as any).operation === "remove",
    )
    expect(edit).toBeDefined()
    return edit
}
