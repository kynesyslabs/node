/**
 * The value rules at pool admission (gossip ingest and the consensus merge
 * run `verifyAdmissionEdits`) and at RPC submission: a native send pays what
 * its body names, accounts are spelled in lowercase, and a native fee is the
 * network's. Each holds behind its own fork; dormant, admission is unchanged.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"

let tip = 100
mock.module("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: { getLastBlockNumber: async () => tip },
}))
mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: { debug: () => {}, info: () => {}, warning: () => {}, error: () => {}, only: () => {}, custom: () => {} },
}))

import { DemosTransactions } from "@kynesyslabs/demosdk/websdk"
import type { Transaction } from "@kynesyslabs/demosdk/types"
import type { ForkConfigByName } from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"
import { OS, PEER, SENDER, chainIs, demos, onTheWire } from "./editBinding.fixtures"
import { verifyAdmissionEdits, verifyRpcEdits } from "./editBinding"
import { nativeSendRefusal, nonCanonicalAddressRefusal } from "./nativeValueRules"
import { feeBindingRefusal } from "./feeBinding"

const PEER_UPPER = "0x" + PEER.slice(2).toUpperCase()
const saved = {
    forkConfig: getSharedState.forkConfig,
    networkFee: getSharedState.networkFee,
    rpcFee: getSharedState.rpcFee,
    additionalFee: getSharedState.additionalFee,
}
const sdkParams = demos._getNetworkParametersCached
const sdkApplyFee = demos._calculateAndApplyGasFee

type Rules = { send?: boolean; canonical?: boolean; fee?: boolean; gasFee?: boolean; editBinding?: number | null }

function forks(rules: Rules, postFork = true) {
    chainIs(postFork, rules.editBinding === undefined ? 0 : rules.editBinding)
    const config = getSharedState.forkConfig as ForkConfigByName & Record<string, { activationHeight: number | null }>
    config.gasFeeSeparation.activationHeight = rules.gasFee ? 0 : null
    config.nativeSendBinding = { activationHeight: rules.send ? 0 : null }
    config.canonicalAddresses = { activationHeight: rules.canonical ? 0 : null }
    config.feeBinding = { activationHeight: rules.fee ? 0 : null }
    tip = 100
}

/** A send signed by the real signer whose body and args can disagree. */
async function send(opts: { to: string; amount: bigint | number; argsTo?: string; argsAmount?: string | number }) {
    const tx = DemosTransactions.empty()
    tx.content.type = "native" as never
    tx.content.to = opts.to
    tx.content.amount = opts.amount as never
    tx.content.nonce = 8
    tx.content.timestamp = Date.now()
    tx.content.data = [
        "native",
        { nativeOperation: "send", args: [opts.argsTo ?? opts.to, opts.argsAmount ?? String(opts.amount)] },
    ] as never
    return onTheWire(await demos.sign(tx)) as Transaction
}

async function payWithFee(fee: Record<string, unknown>): Promise<Transaction> {
    demos._getNetworkParametersCached = async () => {
        throw new Error("offline")
    }
    demos._calculateAndApplyGasFee = (raw: any) => {
        raw.content.transaction_fee = fee
        return raw
    }
    try {
        return onTheWire(await DemosTransactions.pay(PEER, 3n * OS, demos))
    } finally {
        demos._getNetworkParametersCached = sdkParams
        demos._calculateAndApplyGasFee = sdkApplyFee
    }
}

const honest = async () => onTheWire(await DemosTransactions.pay(PEER, 3n * OS, demos)) as Transaction

beforeEach(() => {
    getSharedState.networkFee = 1
    getSharedState.rpcFee = 0
    getSharedState.additionalFee = 0
})

afterEach(() => {
    Object.assign(getSharedState, saved)
})

describe("nativeSendRefusal", () => {
    it("passes a send built by the SDK, on either side of osDenomination", async () => {
        forks({}, true)
        expect(nativeSendRefusal(await honest())).toBeNull()
        forks({}, false)
        expect(nativeSendRefusal(await honest())).toBeNull()
    })

    it("refuses args that pay another recipient or amount", async () => {
        forks({})
        expect(nativeSendRefusal(await send({ to: SENDER, amount: 3n * OS, argsTo: PEER }))).toContain("recipient")
        expect(nativeSendRefusal(await send({ to: PEER, amount: 1n, argsAmount: String(50n * OS) }))).toContain("amount")
    })

    it("refuses args that are not [to, amount] and amounts that are not integers", async () => {
        forks({})
        const tx = await honest()
        ;(tx.content.data as any)[1].args = [PEER]
        expect(nativeSendRefusal(tx)).toContain("[to, amount]")
        ;(tx.content.data as any)[1].args = [PEER, "3000000000", "extra"]
        expect(nativeSendRefusal(tx)).toContain("[to, amount]")
        ;(tx.content.data as any)[1].args = [PEER, "3e9"]
        tx.content.amount = "3e9" as never
        expect(nativeSendRefusal(tx)).toContain("amount")
    })

    it("compares the integer the body and the args name, whatever the JSON type", async () => {
        forks({})
        const tx = await honest()
        // A stored row can surface the body amount as a number.
        tx.content.amount = 3_000_000_000 as never
        expect(nativeSendRefusal(tx)).toBeNull()
    })

    it("leaves other native operations and other types alone", async () => {
        forks({})
        const tx = await honest()
        ;(tx.content.data as any)[1] = { nativeOperation: "tlsn_request", args: ["https://example.com"] }
        expect(nativeSendRefusal(tx)).toBeNull()
        tx.content.type = "contractCall" as never
        expect(nativeSendRefusal(tx)).toBeNull()
    })
})

describe("nonCanonicalAddressRefusal", () => {
    it("passes a lowercase transfer", async () => {
        forks({})
        expect(nonCanonicalAddressRefusal(await honest())).toBeNull()
    })

    it("refuses an upper-case recipient, sender, fee account or balance edit account", async () => {
        forks({})
        expect(nonCanonicalAddressRefusal(onTheWire(await DemosTransactions.pay(PEER_UPPER, 3n * OS, demos)))).toContain(
            "recipient",
        )

        const sender = await honest()
        sender.content.from = "0x" + (sender.content.from as string).slice(2).toUpperCase()
        expect(nonCanonicalAddressRefusal(sender)).toContain("sender")

        const fee = await honest()
        fee.content.transaction_fee.rpc_address = PEER_UPPER
        expect(nonCanonicalAddressRefusal(fee)).toContain("rpc_address")

        const work = await honest()
        work.content.type = "atomicWork" as never
        ;(work.content.gcr_edits as any[]).push({ type: "balance", operation: "add", account: PEER_UPPER, amount: "1", isRollback: false, txhash: "" })
        expect(nonCanonicalAddressRefusal(work)).toContain("balance edit")
    })

    it("refuses a send recipient that is not a full address", async () => {
        forks({})
        const tx = await honest()
        ;(tx.content.data as any)[1].args[0] = PEER.slice(2)
        expect(nonCanonicalAddressRefusal(tx)).toContain("recipient")
    })
})

describe("feeBindingRefusal", () => {
    it("passes the network fee, as an OS string or a DEM number", async () => {
        forks({ gasFee: true }, true)
        expect(await feeBindingRefusal(await honest())).toBeNull()
        forks({ gasFee: true }, false)
        expect(await feeBindingRefusal(await honest())).toBeNull()
    })

    it("refuses an understated fee, a skewed split, a missing fee and a chosen rpc account", async () => {
        forks({ gasFee: true })
        expect(await feeBindingRefusal(await payWithFee({ network_fee: "0", rpc_fee: "0", additional_fee: "0", rpc_address: null }))).toContain(
            "network_fee",
        )
        getSharedState.rpcFee = 1
        expect(
            await feeBindingRefusal(await payWithFee({ network_fee: "2000000000", rpc_fee: "0", additional_fee: "0", rpc_address: null })),
        ).toContain("mismatch")
        expect(
            await feeBindingRefusal(
                await payWithFee({ network_fee: "1000000000", rpc_fee: "1000000000", additional_fee: "0", rpc_address: SENDER }),
            ),
        ).toContain("rpc_address")
        const bare = await honest()
        ;(bare.content as any).transaction_fee = null
        expect(await feeBindingRefusal(bare)).toContain("no transaction_fee")
    })

    it("judges nothing while gasFeeSeparation is off, and no other type", async () => {
        forks({})
        expect(await feeBindingRefusal(await payWithFee({ network_fee: "0", rpc_fee: "0", additional_fee: "0", rpc_address: null }))).toBeNull()
        forks({ gasFee: true })
        const other = await payWithFee({ network_fee: "0", rpc_fee: "0", additional_fee: "0", rpc_address: null })
        other.content.type = "contractCall" as never
        expect(await feeBindingRefusal(other)).toBeNull()
    })
})

describe("pool admission (gossip ingest and consensus merge)", () => {
    it("admits a mismatched, upper-case or underpaying native transaction while the forks are dormant", async () => {
        forks({ gasFee: true })
        expect((await verifyAdmissionEdits(await send({ to: SENDER, amount: 3n * OS, argsTo: PEER }))).ok).toBe(true)
        expect((await verifyAdmissionEdits(onTheWire(await DemosTransactions.pay(PEER_UPPER, 3n * OS, demos)))).ok).toBe(true)
        expect(
            (await verifyAdmissionEdits(await payWithFee({ network_fee: "0", rpc_fee: "0", additional_fee: "0", rpc_address: null }))).ok,
        ).toBe(true)
    })

    for (const editBinding of [0, null]) {
        it(`refuses each behind its fork, with editBinding ${editBinding === null ? "dormant" : "active"}`, async () => {
            forks({ gasFee: true, send: true, canonical: true, fee: true, editBinding })
            const mismatched = await verifyAdmissionEdits(await send({ to: SENDER, amount: 3n * OS, argsTo: PEER }))
            expect(mismatched).toEqual({ ok: false, reason: "native send pays another recipient than content.to" })
            const upper = await verifyAdmissionEdits(onTheWire(await DemosTransactions.pay(PEER_UPPER, 3n * OS, demos)))
            expect(upper.ok).toBe(false)
            expect(upper.reason).toContain("lowercase")
            const cheap = await verifyAdmissionEdits(
                await payWithFee({ network_fee: "0", rpc_fee: "0", additional_fee: "0", rpc_address: null }),
            )
            expect(cheap.ok).toBe(false)
            expect(cheap.reason).toContain("network_fee")

            expect(await verifyAdmissionEdits(await honest())).toEqual({ ok: true })
        })
    }

    it("refuses them at RPC submission behind the forks too", async () => {
        forks({ gasFee: true, send: true, canonical: true, fee: true, editBinding: null })
        expect((await verifyRpcEdits(await send({ to: SENDER, amount: 3n * OS, argsTo: PEER }))).ok).toBe(false)
        expect((await verifyRpcEdits(await honest())).ok).toBe(true)
    })
})
