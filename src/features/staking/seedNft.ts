import { isAllowlistedMint } from "./nftAllowlist"
import { verifyCurrentOwner, verifyNftProof } from "./solanaProof"
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

/** Whether a seeded row takes a seat; an exited row carries no NFT rules. */
function holdsSeat(row: Pick<SeededValidatorNft, "status">): boolean {
    return (
        row.status === undefined ||
        row.status === null ||
        row.status === VALIDATOR_STATUS_ACTIVE ||
        row.status === VALIDATOR_STATUS_UNSTAKING
    )
}

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
        if (!holdsSeat(row)) return
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

/**
 * The seeded-set rules, then the Solana side of every proof: the proof
 * checks out and the wallet still holds the NFT. Age is not checked, a
 * genesis proof is as old as the launch. An unreachable chain is a reason
 * too: a node that cannot verify its seats does not seat them.
 */
export async function verifySeededNfts(
    rows: readonly SeededValidatorNft[],
    label: string,
): Promise<string[]> {
    const reasons = seededNftReasons(rows, label)
    if (reasons.length > 0) return reasons
    const checks = rows.map(async (row, index) => {
        if (!holdsSeat(row) || isNftExemptSeed(row)) return null
        const where = `${label}[${index}] (${row.address})`
        const nft = {
            mint: row.nft_mint as string,
            owner: row.nft_owner as string,
            proofTx: row.nft_proof_tx as string,
        }
        const proof = await verifyNftProof(nft, row.address, Date.now(), Infinity)
        if (proof.status !== "valid") return `${where}: NFT proof ${proof.status}: ${proof.reason}`
        const owner = await verifyCurrentOwner(nft.mint, nft.owner)
        if (owner.status !== "valid") return `${where}: NFT ownership ${owner.status}: ${owner.reason}`
        return null
    })
    return (await Promise.all(checks)).filter((r): r is string => r !== null)
}
