/**
 * Under `xmRemoveCanonical` an xm identity remove finds stored entries by the
 * chain's canonical address form, not by the op's `isEVM` flag. Below the fork
 * height the old comparison stays, so old blocks replay the same way.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { DEFAULT_FORK_CONFIG, cloneDefaultForkConfig, type ForkConfigByName } from "@/forks/forkConfig"
import { loadForkConfigFromGenesis } from "@/forks/loadForkConfig"
import { getSharedState } from "@/utilities/sharedState"
import {
    applyXmIdentityRemove,
    rollbackXmIdentityRemove,
} from "@/libs/blockchain/gcr/gcr_routines/routines/xmRoutines"
import type { EditPlace } from "@/libs/blockchain/gcr/gcr_routines/routines/removedIdentities"
import template from "../../docs/mainnet/genesis.template.json"

const ACCOUNT = "0x" + "11".repeat(32)
const EVM_MIXED = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01"
const EVM_LOWER = EVM_MIXED.toLowerCase()
// Two distinct base58 addresses that differ only in case.
const SOL_A = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
const SOL_B = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsu"

function account(chain: string, addresses: string[]): any {
    return {
        pubkey: ACCOUNT,
        identities: {
            xm: {
                [chain]: {
                    mainnet: addresses.map(address => ({
                        address,
                        signature: "sig-" + address,
                        publicKey: "",
                        timestamp: 1,
                        signedData: "d",
                    })),
                },
            },
        },
    }
}

const removeOp = (chain: string, targetAddress: string, isEVM: boolean) => ({
    account: ACCOUNT,
    data: { chain, subchain: "mainnet", targetAddress, isEVM },
})

const left = (acc: any, chain: string) =>
    acc.identities.xm[chain].mainnet.map((id: any) => id.address)

describe("xmRemoveCanonical", () => {
    let saved: { forkConfig: ForkConfigByName; lastBlockNumber: number }

    beforeEach(() => {
        saved = {
            forkConfig: getSharedState.forkConfig,
            lastBlockNumber: getSharedState.lastBlockNumber,
        }
        getSharedState.forkConfig = cloneDefaultForkConfig()
        getSharedState.lastBlockNumber = 10
    })

    afterEach(() => {
        getSharedState.forkConfig = saved.forkConfig
        getSharedState.lastBlockNumber = saved.lastBlockNumber
    })

    const activateAt = (h: number) =>
        loadForkConfigFromGenesis({ forks: { xmRemoveCanonical: { activationHeight: h } } })

    it("ships dormant and is scheduled at 0 by the mainnet genesis template", () => {
        expect(DEFAULT_FORK_CONFIG.xmRemoveCanonical.activationHeight).toBeNull()
        expect(
            (template.forks as Record<string, { activationHeight: unknown }>)
                .xmRemoveCanonical.activationHeight,
        ).toBe(0)
    })

    it("removes an EVM entry whatever the op's isEVM flag and spelling once active", async () => {
        activateAt(10)
        const acc = account("evm", [EVM_LOWER])
        const r = await applyXmIdentityRemove(removeOp("evm", EVM_MIXED, false), acc)
        expect(r.success).toBe(true)
        expect(left(acc, "evm")).toEqual([])
    })

    it("does not take a case-variant entry on a case-sensitive chain once active", async () => {
        activateAt(10)
        const acc = account("solana", [SOL_A, SOL_B])
        const r = await applyXmIdentityRemove(removeOp("solana", SOL_A, true), acc)
        expect(r.success).toBe(true)
        expect(left(acc, "solana")).toEqual([SOL_B])
    })

    it("keeps the old comparison below the fork height", async () => {
        activateAt(11)
        const evm = account("evm", [EVM_LOWER])
        expect((await applyXmIdentityRemove(removeOp("evm", EVM_MIXED, false), evm)).success).toBe(false)
        const sol = account("solana", [SOL_A, SOL_B])
        expect((await applyXmIdentityRemove(removeOp("solana", SOL_A, true), sol)).success).toBe(true)
        expect(left(sol, "solana")).toEqual([])
    })

    it("rolls a canonical remove back to the same entry", async () => {
        activateAt(10)
        const place: EditPlace = { txhash: "aa", position: 0, removed: new Map() }
        const acc = account("evm", [EVM_LOWER])
        const op = removeOp("evm", EVM_MIXED, false)
        expect((await applyXmIdentityRemove(op, acc, place)).success).toBe(true)
        expect((await rollbackXmIdentityRemove(op, acc, place)).success).toBe(true)
        expect(left(acc, "evm")).toEqual([EVM_LOWER])
    })
})
