import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals"

// Block 0 under nftValidatorGating at 0 checks its seats offline: the genesis
// was sealed after go/no-go read every proof on Solana, so a node building it
// never reads Solana. Every Solana call here answers "unreachable" and counts.

const solanaCalls = jest.fn()
const unreachable = async (...args: unknown[]) => {
    solanaCalls(...args)
    return { status: "unreachable", reason: "all endpoints down" }
}
jest.mock("@/features/staking/solanaProof", () => ({
    __esModule: true,
    verifyNftProof: unreachable,
    verifyCurrentOwner: unreachable,
    verifyChallengeEvidence: unreachable,
    verifyProofSupersedes: unreachable,
}))

const state: { forkConfig: Record<string, unknown>; chainId: number | null } = {
    forkConfig: { nftValidatorGating: { activationHeight: 0 } },
    chainId: 8587492,
}
jest.mock("@/utilities/sharedState", () => ({ __esModule: true, getSharedState: state }))

jest.mock("@/utilities/logger", () => ({
    __esModule: true,
    default: { info: jest.fn(), debug: jest.fn(), warning: jest.fn(), error: jest.fn(), custom: jest.fn() },
}))

import { readFileSync } from "node:fs"
import { NFT_ALLOWLIST_PATH } from "@/features/staking/nftAllowlist"
import { seedValidators } from "@/libs/blockchain/genesis/seedValidators"
import { nftCheckedValidators } from "@/libs/blockchain/genesis/restoreSnapshot"

const MINTS: string[] = JSON.parse(readFileSync(NFT_ALLOWLIST_PATH, "utf8")).mints
const OWNER = "35MxXW1w6WodorZqZxoZVpXaukNo2n6q2T8zwgamPL3e"
const SIG = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW"
const address = (i: number) => "0x" + (i + 1).toString(16).padStart(64, "0")

const seat = (i: number, over: Record<string, unknown> = {}) => ({
    address: address(i),
    status: "2",
    connection_url: null,
    staked_amount: "0",
    first_seen: 0,
    valid_at: 0,
    nft_mint: MINTS[i],
    nft_owner: OWNER,
    nft_proof_tx: SIG,
    ...over,
})
const snapshotRow = (i: number, over: Record<string, unknown> = {}) => ({
    ...seat(i),
    unstake_requested_at: null,
    unstake_available_at: null,
    ...over,
})

/** An entity manager over an empty validators table that records inserts. */
function entityManager() {
    const inserted: unknown[] = []
    return {
        inserted,
        query: jest.fn(async () => [{ count: "0" }]),
        insert: jest.fn(async (_entity: unknown, rows: unknown[]) => {
            inserted.push(...rows)
        }),
    }
}

async function drain(rows: unknown[]): Promise<unknown[]> {
    async function* source() {
        yield* rows
    }
    const out: unknown[] = []
    for await (const row of nftCheckedValidators(source() as never)) out.push(row)
    return out
}

beforeEach(() => {
    solanaCalls.mockClear()
    state.forkConfig = { nftValidatorGating: { activationHeight: 0 } }
    state.chainId = 8587492
})

afterEach(() => {
    expect(solanaCalls).not.toHaveBeenCalled()
})

describe("block 0 from genesis.validators", () => {
    it("builds with Solana unreachable", async () => {
        const em = entityManager()
        const seats = Array.from({ length: 10 }, (_, i) => seat(i))
        expect(await seedValidators(em as never, seats as never)).toEqual({ inserted: 10 })
        expect(em.inserted[3]).toMatchObject({ nft_mint: MINTS[3], nft_owner: OWNER, nft_proof_tx: SIG })
    })

    it("refuses an unlisted mint offline", async () => {
        const em = entityManager()
        const seats = [seat(0), seat(1, { nft_mint: "1".repeat(44) })]
        await expect(seedValidators(em as never, seats as never)).rejects.toThrow(
            `genesis.validators[1] (${address(1)}): nft_mint ${"1".repeat(44)} is not on the allowlist`,
        )
        expect(em.insert).not.toHaveBeenCalled()
    })

    it("refuses a mint backing two seats offline", async () => {
        const em = entityManager()
        const seats = [seat(0), seat(1, { nft_mint: MINTS[0] })]
        await expect(seedValidators(em as never, seats as never)).rejects.toThrow(
            `nft_mint ${MINTS[0]} already backs ${address(0)}`,
        )
        expect(em.insert).not.toHaveBeenCalled()
    })

    it("refuses a malformed owner or proof offline", async () => {
        await expect(seedValidators(entityManager() as never, [seat(0, { nft_owner: "0xnot-base58" })] as never)).rejects.toThrow(
            "nft_owner must be a base58 string",
        )
        await expect(seedValidators(entityManager() as never, [seat(0, { nft_proof_tx: null })] as never)).rejects.toThrow(
            "nft_proof_tx must be a base58 string",
        )
    })

    it("refuses nft_exempt on a mainnet chain id and seats it on a test network", async () => {
        const exempt = { ...seat(1), nft_mint: undefined, nft_owner: undefined, nft_proof_tx: undefined, nft_exempt: true }
        await expect(seedValidators(entityManager() as never, [seat(0), exempt] as never)).rejects.toThrow(
            "nft_exempt is refused on a mainnet chain id",
        )
        state.chainId = 1337
        expect(await seedValidators(entityManager() as never, [seat(0), exempt] as never)).toEqual({ inserted: 2 })
    })
})

describe("block 0 from the snapshot's validators.jsonl", () => {
    it("builds with Solana unreachable", async () => {
        const rows = Array.from({ length: 10 }, (_, i) => snapshotRow(i))
        expect(await drain(rows)).toHaveLength(10)
    })

    it("refuses an unlisted or a duplicated mint offline", async () => {
        await expect(drain([snapshotRow(0), snapshotRow(1, { nft_mint: "1".repeat(44) })])).rejects.toThrow(
            "is not on the allowlist",
        )
        await expect(drain([snapshotRow(0), snapshotRow(1, { nft_mint: MINTS[0] })])).rejects.toThrow(
            `nft_mint ${MINTS[0]} already backs ${address(0)}`,
        )
    })

    it("refuses a seat without NFT fields on a mainnet chain id, and reads it as judged on a test network", async () => {
        const bare = snapshotRow(1, { nft_mint: null, nft_owner: null, nft_proof_tx: null })
        await expect(drain([snapshotRow(0), bare])).rejects.toThrow(
            `validators.jsonl[1] (${address(1)}): nft_mint must be a base58 string`,
        )
        state.chainId = 1
        expect(await drain([snapshotRow(0), bare])).toHaveLength(2)
    })

    it("passes every row through untouched before the fork", async () => {
        state.forkConfig = {}
        expect(await drain([snapshotRow(0, { nft_mint: null })])).toHaveLength(1)
    })
})
