/**
 * A client whose transaction a launch gate (`l2psGate`, `tlsnDisabled`)
 * refuses at RPC validation is told the gate, not an edit mismatch. The
 * confirm step, the edit binding and the SDK builders are the real ones; the
 * chain, the GCR reads, admission and the signatures are replaced.
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
        getAccountNonce: async () => 0,
        getAccountBalance: async () => 1_000_000_000_000_000n,
    },
}))
mock.module("src/libs/blockchain/validation/txAdmission", () => ({
    checkTxAdmissible: async () => ({ ok: true }),
}))
mock.module("src/libs/blockchain/validation/validityData", () => ({
    signValidityData: async (v: unknown) => v,
}))
mock.module("src/libs/blockchain/validation/txValidatorPool", () => ({
    __esModule: true,
    default: {
        getInstance: () => ({ sign: async () => ({ signature: new Uint8Array(1) }) }),
    },
}))

import { SENDER } from "src/libs/blockchain/validation/editBinding.fixtures"
import { featureGates, l2psEncrypted, tlsnTxs } from "@/libs/blockchain/testSupport/featureGateTxs"

const { handleValidateTransaction } = await import("./endpointValidation")
const { L2PS_GATE_REFUSAL } = await import("@/forks/l2psGate")
const { TLSN_DISABLED_REFUSAL } = await import("@/forks/tlsnDisabledGate")

describe("RPC validation under the launch gates", () => {
    it("names tlsnDisabled to a client sending a TLSNotary request or store", async () => {
        featureGates(null, 0)
        for (const tx of await tlsnTxs()) {
            const out = await handleValidateTransaction(tx, SENDER)
            expect(out.data.valid).toBe(false)
            expect(out.data.message).toContain(TLSN_DISABLED_REFUSAL)
            expect(out.data.message).not.toContain("GCREdit mismatch")
        }
    })

    it("names l2psGate to a client sending an L2PS transaction", async () => {
        featureGates(0, null)
        const out = await handleValidateTransaction(await l2psEncrypted(), SENDER)
        expect(out.data.valid).toBe(false)
        expect(out.data.message).toContain(L2PS_GATE_REFUSAL)
    })
})
