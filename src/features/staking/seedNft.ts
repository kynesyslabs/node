import { isAllowlistedMint } from "./nftAllowlist"
import { getMinValidatorStake } from "./minStake"
import { VALIDATOR_STATUS_ACTIVE, VALIDATOR_STATUS_UNSTAKING } from "./constants"

/** The columns of a seeded validator row the NFT rules read. */
export interface SeededValidatorNft {
    address: string
    status?: string | null
    staked_amount: string
    nft_mint?: string | null
    nft_owner?: string | null
    nft_proof_tx?: string | null
    /** Genesis only: the seat holds without an NFT. A snapshot row never is. */
    nft_exempt?: boolean | null
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,88}$/

/** Whether a seeded row opts out of the NFT fields. Only a literal `true` counts. */
export function isNftExemptSeed(row: Pick<SeededValidatorNft, "nft_exempt">): boolean {
    return row.nft_exempt === true
}

/** The addresses of the seeded rows that opt out of the NFT fields. */
export function nftExemptSeeds(rows: readonly SeededValidatorNft[]): string[] {
    return rows.filter(isNftExemptSeed).map(row => row.address)
}

/**
 * The reasons a seeded validator set breaks the NFT rules: every row that
 * holds a seat carries a proof, its mint is allowlisted, no mint backs two
 * seats, and the stake meets the minimum. An exempt row skips the NFT
 * fields and is still held to the minimum stake.
 */
export function seededNftReasons(
    rows: readonly SeededValidatorNft[],
    label: string,
): string[] {
    const reasons: string[] = []
    const min = getMinValidatorStake()
    const holders = new Map<string, string>()
    rows.forEach((row, index) => {
        const where = `${label}[${index}] (${row.address})`
        const seated =
            row.status === undefined ||
            row.status === null ||
            row.status === VALIDATOR_STATUS_ACTIVE ||
            row.status === VALIDATOR_STATUS_UNSTAKING
        if (!seated) return
        if (row.nft_exempt !== undefined && row.nft_exempt !== null && typeof row.nft_exempt !== "boolean") {
            reasons.push(`${where}: nft_exempt must be a boolean`)
            return
        }
        const exempt = isNftExemptSeed(row)
        if (exempt) {
            for (const key of ["nft_mint", "nft_owner", "nft_proof_tx"] as const) {
                const value = row[key]
                if (value !== undefined && value !== null) {
                    reasons.push(`${where}: nft_exempt rows carry no ${key}`)
                    return
                }
            }
        }
        for (const key of exempt ? [] : (["nft_mint", "nft_owner", "nft_proof_tx"] as const)) {
            const value = row[key]
            if (typeof value !== "string" || !BASE58.test(value)) {
                reasons.push(`${where}: ${key} must be a base58 string`)
                return
            }
        }
        if (!exempt) {
            const mint = row.nft_mint as string
            if (!isAllowlistedMint(mint)) {
                reasons.push(`${where}: nft_mint ${mint} is not on the allowlist`)
            }
            const other = holders.get(mint)
            if (other !== undefined) {
                reasons.push(`${where}: nft_mint ${mint} already backs ${other}`)
            } else {
                holders.set(mint, row.address)
            }
        }
        let stake: bigint | null = null
        try {
            stake = BigInt(row.staked_amount)
        } catch {
            stake = null
        }
        if (stake !== null && stake < min) {
            reasons.push(`${where}: staked_amount ${stake} is below the minimum ${min}`)
        }
    })
    return reasons
}
