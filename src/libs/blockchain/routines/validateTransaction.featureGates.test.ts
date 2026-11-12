/**
 * RPC confirm refuses an L2PS transaction under `l2psGate` and a TLSNotary
 * request or store under `tlsnDisabled`, before a fee is quoted or an L2PS
 * payload is decrypted, so a client never holds valid validity data for one.
 * The chain, the GCR reads, admission and the validity signature are
 * replaced.
 */

import { afterEach, describe, expect, it, mock } from "bun:test"

const quiet = Object.fromEntries(
    ["debug", "info", "warning", "warn", "error", "only", "custom"].map(level => [level, () => {}]),
)
mock.module("src/utilities/logger", () => ({ __esModule: true, default: quiet }))
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

import { TLSNotaryService } from "@kynesyslabs/demosdk/tlsnotary/service"
import type { Transaction } from "@kynesyslabs/demosdk/types"
import { getSharedState } from "@/utilities/sharedState"
import { OS, SENDER, chainIs, demos, handMade, onTheWire } from "src/libs/blockchain/validation/editBinding.fixtures"

const { confirmTransaction } = await import("./validateTransaction")
const { L2PS_GATE_REFUSAL } = await import("@/forks/l2psGate")
const { TLSN_DISABLED_REFUSAL } = await import("@/forks/tlsnDisabledGate")
const { default: ParallelNetworks } = await import("@/libs/l2ps/parallelNetworks")

const savedForks = getSharedState.forkConfig
afterEach(() => {
    getSharedState.forkConfig = savedForks
})

const confirm = async (tx: Transaction) => (await confirmTransaction(tx as never, SENDER)).data

function forks(l2psGate: number | null, tlsnDisabled: number | null) {
    chainIs(true, 0)
    const config = getSharedState.forkConfig as unknown as Record<string, { activationHeight: number | null }>
    config.l2psGate = { activationHeight: l2psGate }
    config.tlsnDisabled = { activationHeight: tlsnDisabled }
}

const encrypted = async () =>
    onTheWire(await handMade("l2psEncryptedTx", { l2ps_uid: "net", encrypted_data: "x", tag: "t", original_hash: "ab".repeat(32) }))
const tlsnService = () => {
    demos.connected = true
    return new TLSNotaryService(demos) as any
}

describe("confirm under l2psGate", () => {
    it("refuses every L2PS type before the L2PS payload is read", async () => {
        forks(0, null)
        const loads: string[] = []
        const instance = ParallelNetworks.getInstance() as any
        const original = { getL2PS: instance.getL2PS, loadL2PS: instance.loadL2PS }
        instance.getL2PS = async (uid: string) => (loads.push(uid), null)
        instance.loadL2PS = async (uid: string) => (loads.push(uid), null)
        try {
            for (const tx of [
                await encrypted(),
                onTheWire(await handMade("subnet", { l2ps_uid: "net" })),
                onTheWire(await handMade("l2ps_hash_update", { l2ps_uid: "net", consolidated_hash: "cd".repeat(32), transaction_count: 1 })),
            ]) {
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
        const data = await confirm(await encrypted())
        expect(data.message).not.toContain(L2PS_GATE_REFUSAL)
    })
})

describe("confirm under tlsnDisabled", () => {
    const request = async () => onTheWire(await tlsnService().createTlsnRequestTransaction("https://example.com", 8))
    const store = async () => onTheWire(await tlsnService().createTlsnStoreTransaction("token-1", "proof", "onchain", 2n * OS, 8))

    it("refuses a request and a store", async () => {
        forks(null, 0)
        for (const tx of [await request(), await store()]) {
            const data = await confirm(tx)
            expect(data.valid).toBe(false)
            expect(data.message).toBe(`[Tx Validation] [TYPE ERROR] ${TLSN_DISABLED_REFUSAL}\n`)
        }
    })

    it("confirms a request while the fork is dormant", async () => {
        forks(null, null)
        const data = await confirm(await request())
        expect(data.message).not.toContain(TLSN_DISABLED_REFUSAL)
    })
})
