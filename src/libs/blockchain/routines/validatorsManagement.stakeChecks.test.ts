import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"

/**
 * The entry node's checks under `stakeApplyChecks`: a stake leaves the
 * balance, so the balance must cover the new stake (not the running total),
 * an exited validator may come back with the minimum, and an unstake that
 * apply would refuse below the committee floor is refused up front.
 */

mock.module("@/libs/blockchain/routines/calculateCurrentGas", () => ({
    __esModule: true,
    calculateFeeBreakdown: async () => ({ total: 1 }),
    default: async () => 1,
}))

const { default: ValidatorsManagement } = await import("./validatorsManagement")
const { default: GCR } = await import("../gcr/gcr")
const { default: Chain } = await import("../chain")
const { getSharedState } = await import("@/utilities/sharedState")
const { cloneDefaultForkConfig } = await import("@/forks/forkConfig")
const { DEFAULT_MIN_VALIDATOR_STAKE } = await import("@/features/staking/constants")

const MIN = BigInt(DEFAULT_MIN_VALIDATOR_STAKE)
const SENDER = "0xabc"

const stakeTx = (amount: bigint, connectionUrl = "https://v.example"): any => ({
    content: {
        type: "validatorStake",
        from_ed25519_address: SENDER,
        data: ["validatorStake", { amount: amount.toString(), connectionUrl }],
    },
})
const unstakeTx = (): any => ({
    content: { type: "validatorUnstake", from_ed25519_address: SENDER, data: ["validatorUnstake", {}] },
})

let savedForkConfig: any

beforeEach(() => {
    savedForkConfig = getSharedState.forkConfig
    getSharedState.forkConfig = cloneDefaultForkConfig()
    getSharedState.forkConfig.stakeApplyChecks.activationHeight = 0
    if (!getSharedState.hasShardSize) getSharedState.setShardSizeFromGenesis(10)
    spyOn(Chain, "getLastBlockNumber").mockResolvedValue(100)
})

afterEach(() => {
    getSharedState.forkConfig = savedForkConfig
})

describe("stake admission under stakeApplyChecks", () => {
    it("checks a top-up against the balance alone, the earlier stake having left it", async () => {
        spyOn(GCR, "getGCRValidatorStatus").mockResolvedValue({
            status: "2",
            staked_amount: MIN.toString(),
            connection_url: "https://v.example",
        } as any)
        spyOn(GCR, "getAccountBalance").mockResolvedValue(11n as any)

        expect((await ValidatorsManagement.manageValidatorStakeTx(stakeTx(10n))).valid).toBe(true)
        expect((await ValidatorsManagement.manageValidatorStakeTx(stakeTx(11n))).valid).toBe(false)
    })

    it("lets an exited validator come back with the minimum only", async () => {
        spyOn(GCR, "getGCRValidatorStatus").mockResolvedValue({
            status: "0",
            staked_amount: "0",
            connection_url: "https://v.example",
        } as any)
        spyOn(GCR, "getAccountBalance").mockResolvedValue(MIN * 2n as any)

        expect((await ValidatorsManagement.manageValidatorStakeTx(stakeTx(MIN - 1n, ""))).valid).toBe(false)
        expect((await ValidatorsManagement.manageValidatorStakeTx(stakeTx(MIN, ""))).valid).toBe(true)
    })
})

describe("unstake admission under stakeApplyChecks", () => {
    const active = (n: number) => Array.from({ length: n }, (_, i) => ({ address: `0xv${i}`, status: "2" }))

    beforeEach(() => {
        spyOn(GCR, "getGCRValidatorStatus").mockResolvedValue({
            status: "2",
            unstake_requested_at: null,
        } as any)
    })

    it("refuses an unstake that leaves the set below the committee floor", async () => {
        spyOn(GCR, "getGCRValidatorsAtBlock").mockResolvedValue(active(7))
        const r = await ValidatorsManagement.manageValidatorUnstakeTx(unstakeTx())
        expect(r.valid).toBe(false)
        expect(r.message).toContain("committee floor")
    })

    it("accepts one that leaves the floor met", async () => {
        spyOn(GCR, "getGCRValidatorsAtBlock").mockResolvedValue(active(8))
        expect((await ValidatorsManagement.manageValidatorUnstakeTx(unstakeTx())).valid).toBe(true)
    })

    it("keeps the old rule before the fork", async () => {
        getSharedState.forkConfig.stakeApplyChecks.activationHeight = null
        spyOn(GCR, "getGCRValidatorsAtBlock").mockResolvedValue(active(1))
        expect((await ValidatorsManagement.manageValidatorUnstakeTx(unstakeTx())).valid).toBe(true)
    })
})
