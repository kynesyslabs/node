/**
 * RPC confirm refuses a cross-chain tx, or a DemosWork tx with a cross-chain
 * step, whose XM script this node could not run, before a fee is quoted. The
 * chain, the GCR reads, admission and the validity signature are replaced.
 */

import { describe, expect, it, mock } from "bun:test"
import { mockLogger } from "@/utilities/testSupport/coreMocks"

mockLogger("src/utilities/logger")
mock.module("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: { getLastBlockNumber: async () => 100 },
}))
mock.module("src/libs/blockchain/gcr/gcr", () => ({
    __esModule: true,
    default: {
        getAccountNonce: async () => 7,
        getAccountBalance: async () => 1_000_000_000_000_000n,
    },
}))
mock.module("src/libs/blockchain/validation/txAdmission", () => ({
    checkTxAdmissible: async () => ({ ok: true }),
}))
mock.module("src/libs/blockchain/validation/validityData", () => ({
    signValidityData: async (v: unknown) => v,
}))

import type { Transaction } from "@kynesyslabs/demosdk/types"
import { SENDER, handMade, onTheWire } from "src/libs/blockchain/validation/editBinding.fixtures"
import { featureGates } from "@/libs/blockchain/testSupport/featureGateTxs"

const { confirmTransaction } = await import("./validateTransaction")

const confirm = async (tx: Transaction) => (await confirmTransaction(tx as never, SENDER)).data

const goodOp = {
    chain: "eth",
    subchain: "sepolia",
    is_evm: true,
    rpc: "",
    task: { type: "pay", params: null, signedPayloads: ["0xf86b"] },
}

describe("confirm checks XM scripts", () => {
    it("refuses a crosschainOperation whose operations is not an object", async () => {
        featureGates(null, null)
        const tx = onTheWire(await handMade("crosschainOperation", { operations: "x" }))
        const data = await confirm(tx)
        expect(data.valid).toBe(false)
        expect(data.message).toContain("[STRUCTURE ERROR] XM script operations is not an object")
    })

    it("refuses a DemosWork tx with a malformed cross-chain step", async () => {
        featureGates(null, null)
        const steps = { s: { context: "xm", content: { operations: { a: { ...goodOp, chain: "nowhere" } } } } }
        const tx = onTheWire(await handMade("demoswork", { steps, operations: {}, operationOrder: [] }))
        const data = await confirm(tx)
        expect(data.valid).toBe(false)
        expect(data.message).toContain("unknown chain")
    })

    it("does not refuse a well-formed script for its shape", async () => {
        featureGates(null, null)
        const tx = onTheWire(
            await handMade("crosschainOperation", { operations: { a: goodOp }, operations_order: ["a"] }),
        )
        const data = await confirm(tx)
        expect(data.message ?? "").not.toContain("XM script")
    })
})
