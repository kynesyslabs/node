import { isAllowlistedMint } from "./nftAllowlist"
import { verifyNftProof } from "./solanaProof"
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

/**
 * `fromChain`: the rows are a chain's own validator table (a snapshot),
 * not a genesis list. A seat there with no NFT fields at all was taken
 * without one, by a genesis `nft_exempt` entry or before the fork, and the
 * table does not keep which; the chain already judged it.
 *
 * `mainnet`: the genesis chain id is not a test network's. No seat there is
 * taken without an NFT, so neither `nft_exempt` nor `fromChain` exempts one.
 */
export interface SeedNftOptions {
    fromChain?: boolean
    mainnet?: boolean
}

function hasNoNftFields(row: SeededValidatorNft): boolean {
    return (
        (row.nft_mint ?? null) === null &&
        (row.nft_owner ?? null) === null &&
        (row.nft_proof_tx ?? null) === null
    )
}

/** Whether a seeded row opts out of the NFT fields. Only a literal `true` counts. */
export function isNftExemptSeed(
    row: SeededValidatorNft,
    options: SeedNftOptions = {},
): boolean {
    if (options.mainnet === true) return false
    return row.nft_exempt === true || (options.fromChain === true && hasNoNftFields(row))
}

/** The addresses of the seeded rows that opt out of the NFT fields. */
export function nftExemptSeeds(rows: readonly SeededValidatorNft[]): string[] {
    return rows.filter(row => isNftExemptSeed(row)).map(row => row.address)
}

/**
 * The reasons a seeded validator set breaks the NFT rules: every row that
 * holds a seat carries a proof, its mint is allowlisted, no mint backs two
 * seats. An exempt row skips the NFT fields. Offline and deterministic: this
 * is all a node checks when it builds block 0, since the genesis hash it
 * pins was sealed after go/no-go read every launch proof on Solana.
 */
export function seededNftReasons(
    rows: readonly SeededValidatorNft[],
    label: string,
    options: SeedNftOptions = {},
): string[] {
    const reasons: string[] = []
    const holders = new Map<string, string>()
    rows.forEach((row, index) => {
        const where = `${label}[${index}] (${row.address})`
        if (!holdsSeat(row)) return
        if (row.nft_exempt !== undefined && row.nft_exempt !== null && typeof row.nft_exempt !== "boolean") {
            reasons.push(`${where}: nft_exempt must be a boolean`)
            return
        }
        if (options.mainnet === true && row.nft_exempt === true) {
            reasons.push(`${where}: nft_exempt is refused on a mainnet chain id`)
            return
        }
        const exempt = isNftExemptSeed(row, options)
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
    })
    return reasons
}

/**
 * The seeded-set rules, then the Solana side of every proof: the signer
 * held the NFT when it was made and bound this address. The check run
 * before a genesis is sealed (launch-go-no-go, genesis-seeds); a node never
 * runs it, so block 0 builds the same with Solana down or its history
 * pruned. Whether the wallet still holds the NFT is not asked; a seat that
 * lost it is challenged in a later block. Age is not checked, a genesis
 * proof is as old as the launch. An unreachable chain is a reason too.
 */
export async function verifySeededNfts(
    rows: readonly SeededValidatorNft[],
    label: string,
    options: SeedNftOptions = {},
): Promise<string[]> {
    const reasons = seededNftReasons(rows, label, options)
    if (reasons.length > 0) return reasons
    const checks = rows.map(async (row, index) => {
        if (!holdsSeat(row) || isNftExemptSeed(row, options)) return null
        const where = `${label}[${index}] (${row.address})`
        const nft = {
            mint: row.nft_mint as string,
            owner: row.nft_owner as string,
            proofTx: row.nft_proof_tx as string,
        }
        const proof = await verifyNftProof(nft, row.address, Date.now(), Infinity)
        if (proof.status !== "valid") return `${where}: NFT proof ${proof.status}: ${proof.reason}`
        return null
    })
    return (await Promise.all(checks)).filter((r): r is string => r !== null)
}
