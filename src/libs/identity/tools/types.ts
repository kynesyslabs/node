/**
 * Shared types for identity tool modules.
 *
 * Every type that was previously exported from an individual tool file is
 * re-exported here so that external consumers can import from a single
 * location while backward-compatible re-exports remain in the original
 * files.
 */

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------

export type DiscordMessage = {
    id: string
    channel_id: string
    guild_id?: string
    author: {
        id: string
        username: string
        global_name?: string
        bot?: boolean
    }
    content: string
    timestamp: string
    edited_timestamp?: string | null
    mention_everyone: boolean
    attachments: Array<{
        id: string
        filename: string
        size: number
        url: string
        proxy_url: string
        content_type?: string
    }>
    embeds: any[]
    mentions: Array<{ id: string; username: string }>
    referenced_message?: DiscordMessage | null
}

// ---------------------------------------------------------------------------
// Nomis
// ---------------------------------------------------------------------------

export interface NomisWalletScorePayload {
    address: string
    score: number
    scoreType: number
    referralCode?: string
    referrerCode?: string
    mintData?: {
        mintedScore?: number
        signature?: string
        deadline?: number
        calculationModel?: number
        chainId?: number
        metadataUrl?: string
        onftMetadataUrl?: string
    }
    migrationData?: {
        blockNumber?: string
        tokenId?: string
        signature?: string
        deadline?: number
    }
    stats?: {
        scoredAt?: string
        walletAge?: number
        totalTransactions?: number
        nativeBalanceUSD?: number
        walletTurnoverUSD?: number
        tokenBalances?: unknown
    }
}

export interface NomisScoreRequestOptions {
    scoreType?: number
    nonce?: number
    deadline?: number
}

export interface NomisApiResponse<T> {
    succeeded: boolean
    messages?: string[]
    data: T
}

// ---------------------------------------------------------------------------
// Human Passport
// ---------------------------------------------------------------------------

/**
 * Human Passport score verification result
 */
export interface HumanPassportVerification {
    address: string
    score: number
    passingScore: boolean
    threshold: number
    stamps: string[]
    lastScoreTimestamp: string
    expirationTimestamp: string | null
    verifiedAt: number
}

/**
 * Raw API response from Human Passport
 */
export interface RawScoreResponse {
    address: string
    score: string
    passing_score: boolean
    last_score_timestamp: string
    expiration_timestamp: string | null
    threshold: string
    error: string | null
    stamps: Record<string, any>
}

/**
 * Cache entry for passport scores
 */
export interface CachedScore {
    data: HumanPassportVerification
    fetchedAt: number
}

// ---------------------------------------------------------------------------
// Ethos
// ---------------------------------------------------------------------------

export interface EthosScorePayload {
    score: number
    profileId?: number
    displayName?: string
    username?: string
}

export interface EthosScoreResponse {
    score: number
}

export interface EthosProfileResponse {
    id: number
    profileId: number
    displayName?: string
    username?: string
    score: number
    status: string
    avatarUrl?: string
}
