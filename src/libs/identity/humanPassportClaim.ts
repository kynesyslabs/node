import type { SavedHumanPassportIdentity } from "@/model/entities/types/IdentityTypes"

/**
 * What a Human Passport identity assign signs. `score` and `threshold` are
 * the values Human Passport reported to the client (the node's
 * `getHumanPassportClaim` routine returns the whole claim); admission checks them
 * against the provider and apply stores them as signed. The optional fields
 * are checked and stored when sent.
 */
export interface HumanPassportClaim {
    address: string
    verificationMethod: "api" | "onchain"
    score: number
    threshold: number
    stamps?: string[]
    lastScoreTimestamp?: string
    expirationTimestamp?: string | null
    chainId?: number
    signature?: string
    referralCode?: string
}

const EVM_ADDRESS = /^0x[0-9a-f]{40}$/i

/**
 * The record a Human Passport claim stores, built from the signed claim
 * alone, or why the claim cannot be stored. Every node applying the edit,
 * including one replaying old blocks, must reach the same record, so
 * nothing here may depend on the time or on the provider.
 */
export function humanPassportRecord(
    claim: unknown,
): SavedHumanPassportIdentity | string {
    if (!claim || typeof claim !== "object") return "missing payload"
    const c = claim as Record<string, unknown>
    if (typeof c.address !== "string" || !EVM_ADDRESS.test(c.address)) {
        return "address must be an EVM address"
    }
    if (c.verificationMethod !== "api" && c.verificationMethod !== "onchain") {
        return "verificationMethod must be api or onchain"
    }
    const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
    if (!finite(c.score) || !finite(c.threshold) || c.threshold <= 0) {
        return "score and threshold are required: send the claim getHumanPassportClaim returns"
    }
    if (c.score < c.threshold) {
        return `score ${c.score} is below the threshold ${c.threshold}`
    }
    if (
        c.stamps !== undefined &&
        (!Array.isArray(c.stamps) || c.stamps.some(s => typeof s !== "string"))
    ) {
        return "stamps must be a list of provider names"
    }
    const time = (v: unknown): number | null | string => {
        if (v === undefined || v === null) return null
        const ms = typeof v === "string" ? Date.parse(v) : Number.NaN
        return Number.isFinite(ms) ? ms : "unparsable timestamp"
    }
    const scoredAt = time(c.lastScoreTimestamp)
    const expiresAt = time(c.expirationTimestamp)
    if (typeof scoredAt === "string" || typeof expiresAt === "string") {
        return "lastScoreTimestamp and expirationTimestamp must be dates"
    }

    const record: SavedHumanPassportIdentity = {
        address: c.address.toLowerCase(),
        score: c.score,
        passingScore: true,
        threshold: c.threshold,
        stamps: [...((c.stamps as string[] | undefined) ?? [])].sort(),
        verificationMethod: c.verificationMethod,
        verifiedAt: scoredAt ?? 0,
        expiresAt,
    }
    if (finite(c.chainId)) record.chainId = c.chainId
    return record
}
