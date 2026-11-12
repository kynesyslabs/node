/**
 * RPC confirm refuses an L2PS transaction under `l2psGate` and a TLSNotary
 * request or store under `tlsnDisabled`, before a fee is quoted or an L2PS
 * payload is decrypted, so a client never holds valid validity data for one.
 * The chain, the GCR reads, admission and the validity signature are
 * replaced.
 */

import { afterEach, describe, expect, it, mock } from "bun:test"
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
import { getSharedState } from "@/utilities/sharedState"
import { SENDER } from "src/libs/blockchain/validation/editBinding.fixtures"
import { featureGates as forks, l2psEncrypted, l2psHashUpdate, l2psSubnet, tlsnRequest, tlsnTxs } from "@/libs/blockchain/testSupport/featureGateTxs"

const { confirmTransaction } = await import("./validateTransaction")
const { L2PS_GATE_REFUSAL } = await import("@/forks/l2psGate")
const { TLSN_DISABLED_REFUSAL } = await import("@/forks/tlsnDisabledGate")
const { default: ParallelNetworks } = await import("@/libs/l2ps/parallelNetworks")

const savedForks = getSharedState.forkConfig
afterEach(() => {
    getSharedState.forkConfig = savedForks
})

const confirm = async (tx: Transaction) => (await confirmTransaction(tx as never, SENDER)).data

describe("confirm under l2psGate", () => {
    it("refuses every L2PS type before the L2PS payload is read", async () => {
        forks(0, null)
        const loads: string[] = []
        const instance = ParallelNetworks.getInstance() as any
        const original = { getL2PS: instance.getL2PS, loadL2PS: instance.loadL2PS }
        instance.getL2PS = async (uid: string) => (loads.push(uid), null)
        instance.loadL2PS = async (uid: string) => (loads.push(uid), null)
        try {
            // A client never submits an l2psBatch; confirm refuses it as node-authored first.
            for (const tx of [await l2psEncrypted(), await l2psSubnet(), await l2psHashUpdate()]) {
                const data = await confirm(tx)
                expect(data.valid).toBe(false)
                expect(data.message).toBe(`[Tx Validation] [TYPE ERROR] ${L2PS_GATE_REFUSAL}\n`)
            }
            expect(loads).toEqual([])
        } finally {
            Object.assign(instance, original)
        }
    })

    it("does not refuse them for L2PS while the gate is dormant", async () => {
        forks(null, null)
        const data = await confirm(await l2psEncrypted())
        expect(data.message).not.toContain(L2PS_GATE_REFUSAL)
    })
})

describe("confirm under tlsnDisabled", () => {
    it("refuses a request and a store", async () => {
        forks(null, 0)
        for (const tx of await tlsnTxs()) {
            const data = await confirm(tx)
            expect(data.valid).toBe(false)
            expect(data.message).toBe(`[Tx Validation] [TYPE ERROR] ${TLSN_DISABLED_REFUSAL}\n`)
        }
    })

    it("confirms a request while the fork is dormant", async () => {
        forks(null, null)
        const data = await confirm(await tlsnRequest())
        expect(data.message).not.toContain(TLSN_DISABLED_REFUSAL)
    })
})
