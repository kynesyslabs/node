import type { GCREdit, Transaction } from "@kynesyslabs/demosdk/types"

/**
 * The attack this guards: `handleGCR` applies `gcr_edits` for a transaction of
 * any type, `GCRIdentityRoutines` has `pointsadd`, and the peer-gossip
 * `mempool` RPC is unauthenticated. A self-signed non-native transaction
 * carrying a balance or points edit was therefore applied as written, because
 * the edit binding only ran for `type === "native"`.
 */

const generate = jest.fn<Promise<GCREdit[]>, [Transaction]>()

jest.mock("@kynesyslabs/demosdk/websdk", () => ({
    GCRGeneration: { generate: (tx: Transaction) => generate(tx) },
}))

// Mirrors the SDK serializer gate: post-fork, a DEM-number balance amount
// goes on the wire as an OS string.
jest.mock("@kynesyslabs/demosdk", () => ({
    denomination: {
        serializeTransactionContent: (content: any, postFork: boolean) => {
            if (!postFork) return JSON.stringify(content)
            const edits = (content.gcr_edits ?? []).map((e: any) =>
                e.type === "balance" && typeof e.amount === "number"
                    ? { ...e, amount: String(BigInt(e.amount) * 1_000_000_000n) }
                    : e,
            )
            return JSON.stringify({ ...content, gcr_edits: edits })
        },
    },
}))

jest.mock("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        only: jest.fn(),
    },
}))

jest.mock("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: { getLastBlockNumber: async () => 0 },
}))

const sharedState = { lastBlockNumber: 0, forkConfig: {} as Record<string, unknown> }

jest.mock("@/utilities/sharedState", () => ({
    getSharedState: sharedState,
}))

import { verifyNoUnexplainedValueEdits } from "./verifyGcrEdits"

const ATTACKER = "0x" + "ab".repeat(32)

function identityTx(edits: GCREdit[]): Transaction {
    return {
        hash: "de".repeat(32),
        content: {
            type: "identity",
            from: ATTACKER,
            from_ed25519_address: ATTACKER,
            gcr_edits: edits,
        },
    } as unknown as Transaction
}

function balanceEdit(amount: string): GCREdit {
    return {
        type: "balance",
        operation: "add",
        account: ATTACKER,
        amount,
        isRollback: false,
        txhash: "",
    } as unknown as GCREdit
}

function pointsEdit(points: number): GCREdit {
    return {
        type: "identity",
        operation: "pointsadd",
        account: ATTACKER,
        context: "web2",
        data: { points },
        isRollback: false,
        txhash: "",
    } as unknown as GCREdit
}

function identityAddEdit(): GCREdit {
    return {
        type: "identity",
        operation: "add",
        account: ATTACKER,
        context: "web2",
        data: { username: "someone" },
        isRollback: false,
        txhash: "",
    } as unknown as GCREdit
}

beforeEach(() => {
    generate.mockReset()
    sharedState.forkConfig = {}
})

describe("verifyNoUnexplainedValueEdits", () => {
    it("rejects a minted balance on a non-native transaction", async () => {
        // The node would generate only the identity edit for this body.
        generate.mockResolvedValue([identityAddEdit()])

        const result = await verifyNoUnexplainedValueEdits(
            identityTx([identityAddEdit(), balanceEdit("1000000000000")]),
        )

        expect(result.ok).toBe(false)
        expect(result.unexplained).toHaveLength(1)
        expect(result.unexplained[0]).toContain("balance")
    })

    it("rejects self-awarded points", async () => {
        generate.mockResolvedValue([identityAddEdit()])

        const result = await verifyNoUnexplainedValueEdits(
            identityTx([identityAddEdit(), pointsEdit(5000)]),
        )

        expect(result.ok).toBe(false)
        expect(result.unexplained[0]).toContain("points")
    })

    it("accepts the points the node itself would award", async () => {
        generate.mockResolvedValue([identityAddEdit(), pointsEdit(10)])

        const result = await verifyNoUnexplainedValueEdits(
            identityTx([identityAddEdit(), pointsEdit(10)]),
        )

        expect(result.ok).toBe(true)
    })

    it("rejects a second copy of an edit the node generated once", async () => {
        generate.mockResolvedValue([pointsEdit(10)])

        const result = await verifyNoUnexplainedValueEdits(
            identityTx([pointsEdit(10), pointsEdit(10)]),
        )

        expect(result.ok).toBe(false)
    })

    it("ignores transactions that move nothing scarce", async () => {
        const result = await verifyNoUnexplainedValueEdits(
            identityTx([identityAddEdit()]),
        )

        expect(result.ok).toBe(true)
        // No value edits shipped — nothing to regenerate or compare.
        expect(generate).not.toHaveBeenCalled()
    })

    it("accepts a fee the generator emits in DEM once the wire carries OS", async () => {
        sharedState.forkConfig = { osDenomination: { activationHeight: 0 } }
        // The generator emits the fee as a DEM number; the wire carries OS.
        generate.mockResolvedValue([
            { ...balanceEdit(""), operation: "remove", amount: 1 } as unknown as GCREdit,
        ])

        const result = await verifyNoUnexplainedValueEdits(
            identityTx([
                { ...balanceEdit("1000000000"), operation: "remove" } as unknown as GCREdit,
            ]),
        )

        expect(result.ok).toBe(true)
    })

    it("still rejects a post-fork amount the generator did not emit", async () => {
        sharedState.forkConfig = { osDenomination: { activationHeight: 0 } }
        generate.mockResolvedValue([
            { ...balanceEdit(""), operation: "remove", amount: 1 } as unknown as GCREdit,
        ])

        const result = await verifyNoUnexplainedValueEdits(
            identityTx([
                { ...balanceEdit("2000000000"), operation: "remove" } as unknown as GCREdit,
            ]),
        )

        expect(result.ok).toBe(false)
        expect(result.unexplained[0]).toContain("2000000000")
    })

    it("fails closed when the edits cannot be regenerated", async () => {
        generate.mockRejectedValue(new Error("generator blew up"))

        const result = await verifyNoUnexplainedValueEdits(
            identityTx([balanceEdit("1")]),
        )

        expect(result.ok).toBe(false)
    })
})
