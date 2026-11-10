import { beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals"

// The seat rules every node applies at block apply, with NFT gating on.

jest.mock("@/utilities/logger", () => ({
    __esModule: true,
    default: { info: jest.fn(), debug: jest.fn(), warning: jest.fn(), error: jest.fn(), custom: jest.fn() },
}))

jest.mock("@/model/datasource", () => ({
    __esModule: true,
    default: { getInstance: jest.fn() },
}))

jest.mock("@/libs/blockchain/chain", () => ({
    __esModule: true,
    default: { getLastBlockNumber: jest.fn(async () => 100) },
}))

jest.mock("@/utilities/sharedState", () => ({
    __esModule: true,
    getSharedState: { networkParameters: { minValidatorStake: "1000" } },
}))

const allowlisted = new Set<string>()
jest.mock("@/features/staking/nftAllowlist", () => ({
    __esModule: true,
    isNftGatingEnabled: jest.fn(() => true),
    isAllowlistedMint: jest.fn((mint: string) => allowlisted.has(mint)),
}))

jest.mock("@/features/staking/solanaProof", () => ({ __esModule: true }))

import {
    VALIDATOR_STATUS_ACTIVE,
    VALIDATOR_STATUS_EXITED,
    VALIDATOR_STATUS_UNSTAKING,
} from "@/features/staking/constants"

let Routines: typeof import("@/libs/blockchain/gcr/gcr_routines/GCRValidatorStakeRoutines").default
beforeAll(async () => {
    Routines = (await import("@/libs/blockchain/gcr/gcr_routines/GCRValidatorStakeRoutines")).default
})

interface Row {
    address: string
    status: string | null
    connection_url: string | null
    staked_amount: string | null
    first_seen: number | null
    valid_at: number | null
    unstake_requested_at: number | null
    unstake_available_at: number | null
    nft_mint: string | null
    nft_owner: string | null
    nft_proof_tx: string | null
}

/** A repository over a map, with the mint lookup the staged repo provides. */
function repo(seed: Row[] = []) {
    const rows = new Map(seed.map(r => [r.address, { ...r }]))
    return {
        rows,
        findOneBy: jest.fn(async ({ address }: { address: string }) => rows.get(address) ?? null),
        findBy: jest.fn(async ({ nft_mint }: { nft_mint: string }) =>
            [...rows.values()].filter(r => r.nft_mint === nft_mint),
        ),
        save: jest.fn(async (row: Row) => {
            rows.set(row.address, { ...row })
            return row
        }),
        create: jest.fn((row: Row) => ({ ...row })),
    }
}

const A = "a".repeat(64)
const B = "b".repeat(64)
const MINT = "7M7TxyCHoX3jmUNh68QxWWnUSbxJwEUTJoN5dHxTctGH"
const MINT2 = "2edqWDWbFkTjkcTb4zzj3PwQBHJeXbFuiAynm4bj46yP"
const OWNER = "35MxXW1w6WodorZqZxoZVpXaukNo2n6q2T8zwgamPL3e"
const SIG = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW"

const row = (address: string, over: Partial<Row> = {}): Row => ({
    address,
    status: VALIDATOR_STATUS_ACTIVE,
    connection_url: "https://v.example",
    staked_amount: "1000",
    first_seen: 1,
    valid_at: 1,
    unstake_requested_at: null,
    unstake_available_at: null,
    nft_mint: MINT,
    nft_owner: OWNER,
    nft_proof_tx: SIG,
    ...over,
})

const stake = (account: string, over: Record<string, unknown> = {}) => ({
    type: "validatorStake",
    isRollback: false,
    account,
    operation: "stake",
    amount: "1000",
    connectionUrl: "https://v.example",
    nft: { mint: MINT, owner: OWNER, proofTx: SIG },
    txhash: "0xtx",
    ...over,
})

beforeEach(() => {
    jest.clearAllMocks()
    allowlisted.clear()
    allowlisted.add(MINT).add(MINT2)
})

describe("a stake that takes a seat", () => {
    it("records the NFT on the new row", async () => {
        const r = repo()
        expect((await Routines.apply(stake(A) as any, r as any, 100)).success).toBe(true)
        expect(r.rows.get(A)).toMatchObject({ nft_mint: MINT, nft_owner: OWNER, nft_proof_tx: SIG })
    })

    it("refuses without an NFT, with an unlisted mint, or below the minimum", async () => {
        expect((await Routines.apply(stake(A, { nft: undefined }) as any, repo() as any, 100)).message).toContain("requires an NFT")
        allowlisted.delete(MINT)
        expect((await Routines.apply(stake(A) as any, repo() as any, 100)).message).toContain("not eligible")
        allowlisted.add(MINT)
        expect((await Routines.apply(stake(A, { amount: "999" }) as any, repo() as any, 100)).message).toContain("below minimum")
    })

    it("evicts the active or unstaking seat the mint backs, including one staged in this block", async () => {
        const closed = { status: VALIDATOR_STATUS_EXITED, staked_amount: "0", unstake_requested_at: null, unstake_available_at: null }

        const active = repo([row(B)])
        expect((await Routines.apply(stake(A) as any, active as any, 100)).success).toBe(true)
        expect(active.rows.get(B)).toMatchObject(closed)
        expect(active.rows.get(A)).toMatchObject({ status: VALIDATOR_STATUS_ACTIVE, nft_mint: MINT })

        const unstaking = repo([row(B, { status: VALIDATOR_STATUS_UNSTAKING, unstake_available_at: 500 })])
        expect((await Routines.apply(stake(A) as any, unstaking as any, 100)).success).toBe(true)
        expect(unstaking.rows.get(B)).toMatchObject(closed)

        // Two stakes for one mint in one block: the later one reads and evicts the first through the repo.
        const sameBlock = repo()
        expect((await Routines.apply(stake(B) as any, sameBlock as any, 100)).success).toBe(true)
        expect((await Routines.apply(stake(A) as any, sameBlock as any, 100)).success).toBe(true)
        expect(sameBlock.rows.get(B)).toMatchObject(closed)
        expect(sameBlock.rows.get(A)?.status).toBe(VALIDATOR_STATUS_ACTIVE)
    })

    it("refuses before touching any seat when the proof is missing or the mint is unlisted", async () => {
        const r = repo([row(B)])
        expect((await Routines.apply(stake(A, { nft: undefined }) as any, r as any, 100)).success).toBe(false)
        allowlisted.delete(MINT)
        expect((await Routines.apply(stake(A) as any, r as any, 100)).success).toBe(false)
        expect(r.save).not.toHaveBeenCalled()
    })

    it("lets a mint whose seat exited back a new seat", async () => {
        const r = repo([row(B, { status: VALIDATOR_STATUS_EXITED, staked_amount: "0" })])
        expect((await Routines.apply(stake(A) as any, r as any, 100)).success).toBe(true)
    })

    it("re-enters an exited validator with the new proof", async () => {
        const r = repo([row(A, { status: VALIDATOR_STATUS_EXITED, staked_amount: "0", nft_mint: MINT2 })])
        expect((await Routines.apply(stake(A) as any, r as any, 100)).success).toBe(true)
        expect(r.rows.get(A)).toMatchObject({ status: VALIDATOR_STATUS_ACTIVE, nft_mint: MINT, valid_at: 100 })
    })

    it("tops up an existing seat without re-checking the NFT", async () => {
        const r = repo([row(A)])
        expect((await Routines.apply(stake(A, { amount: "1", nft: undefined }) as any, r as any, 100)).success).toBe(true)
        expect(r.rows.get(A)?.staked_amount).toBe("1001")
        expect(r.findBy).not.toHaveBeenCalled()
    })
})

describe("evicting a seat", () => {
    const evict = (account: string) => ({
        type: "validatorStake",
        isRollback: false,
        account,
        operation: "evict",
        amount: "0",
        evidenceTx: SIG,
        txhash: "0xtx",
    })

    it("closes an active or unstaking seat at once and zeroes the stake", async () => {
        const r = repo([row(A, { status: VALIDATOR_STATUS_UNSTAKING, unstake_requested_at: 5, unstake_available_at: 1005 })])
        expect((await Routines.apply(evict(A) as any, r as any, 100)).success).toBe(true)
        expect(r.rows.get(A)).toMatchObject({
            status: VALIDATOR_STATUS_EXITED,
            staked_amount: "0",
            unstake_requested_at: null,
            unstake_available_at: null,
        })
    })

    it("refuses a missing or already exited validator", async () => {
        expect((await Routines.apply(evict(A) as any, repo() as any, 100)).message).toContain("not found")
        const exited = repo([row(A, { status: VALIDATOR_STATUS_EXITED })])
        expect((await Routines.apply(evict(A) as any, exited as any, 100)).message).toContain("holds no seat")
    })
})
