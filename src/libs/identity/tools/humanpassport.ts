import axios, { AxiosInstance } from "axios"
import log from "@/utilities/logger"

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
interface RawScoreResponse {
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
interface CachedScore {
    data: HumanPassportVerification
    fetchedAt: number
}

const DEFAULT_BASE_URL = process.env.HUMAN_PASSPORT_API_URL || "https://api.passport.xyz"
const DEFAULT_SCORER_ID = process.env.HUMAN_PASSPORT_SCORER_ID || ""
const DEFAULT_API_KEY = process.env.HUMAN_PASSPORT_API_KEY || ""
const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour

/**
 * Human Passport API Client for Node
 *
 * Provides methods to verify Human Passport scores via the Stamps API v2.
 * Implements caching to reduce API calls.
 */
export class HumanPassportProvider {
    private static instance: HumanPassportProvider
    private readonly http: AxiosInstance
    private readonly scorerId: string
    private readonly cache: Map<string, CachedScore> = new Map()

    private constructor() {
        if (!DEFAULT_API_KEY) {
            throw new Error("HUMAN_PASSPORT_API_KEY is not set in environment variables")
        }

        if (!DEFAULT_SCORER_ID) {
            throw new Error("HUMAN_PASSPORT_SCORER_ID is not set in environment variables")
        }

        this.scorerId = DEFAULT_SCORER_ID

        this.http = axios.create({
            baseURL: DEFAULT_BASE_URL,
            timeout: 30000,
            headers: {
                "X-API-KEY": DEFAULT_API_KEY,
                "Content-Type": "application/json",
            },
        })
    }

    /**
     * Get singleton instance
     */
    static getInstance(): HumanPassportProvider {
        if (!HumanPassportProvider.instance) {
            HumanPassportProvider.instance = new HumanPassportProvider()
        }
        return HumanPassportProvider.instance
    }

    /**
     * Verify an address's Human Passport score
     *
     * @param address EVM address to verify
     * @param forceRefresh Skip cache and fetch fresh data
     * @returns Verification result with score and stamps
     */
    async verifyAddress(
        address: string,
        forceRefresh = false,
    ): Promise<HumanPassportVerification> {
        // Early validation guard for API credentials
        if (!this.scorerId || !this.http.defaults.headers?.["X-API-KEY"]) {
            throw new Error(
                "Human Passport API credentials missing: set HUMAN_PASSPORT_API_KEY and HUMAN_PASSPORT_SCORER_ID"
            )
        }

        // REVIEW: Validate EVM address format to prevent URL path injection
        const evmAddressRegex = /^0x[a-fA-F0-9]{40}$/
        if (!evmAddressRegex.test(address)) {
            throw new Error("Invalid EVM address format: must be 0x followed by 40 hex characters")
        }

        const normalizedAddress = address.toLowerCase()

        // Check cache
        if (!forceRefresh) {
            const cached = this.getFromCache(normalizedAddress)
            if (cached) {
                log.debug(`[HumanPassportProvider] Cache hit for ${normalizedAddress}`)
                return cached
            }
        }

        // Fetch from API
        const apiUrl = `/v2/stamps/${this.scorerId}/score/${normalizedAddress}`

        try {
            const response = await this.http.get<RawScoreResponse>(apiUrl)
            const verification = this.transformResponse(response.data)

            // Cache the result
            this.setInCache(normalizedAddress, verification)

            return verification
        } catch (error: any) {
            log.error(`[HumanPassportProvider] API error for ${normalizedAddress}: ${error.message}`)

            if (error.response?.status === 404) {
                throw new Error(
                    "User has not created a Human Passport. Direct them to https://app.passport.xyz/",
                )
            }

            if (error.response?.status === 429) {
                throw new Error("Human Passport API rate limit exceeded. Try again later.")
            }

            throw error
        }
    }

    /**
     * Check if an address is considered human (score >= threshold)
     */
    async isHuman(address: string, threshold = 20): Promise<boolean> {
        try {
            const verification = await this.verifyAddress(address)
            return verification.score >= threshold
        } catch {
            return false
        }
    }

    /**
     * Get score for an address (returns 0 if no passport)
     */
    async getScore(address: string): Promise<number> {
        try {
            const verification = await this.verifyAddress(address)
            return verification.score
        } catch {
            return 0
        }
    }

    /**
     * Invalidate cache for an address
     */
    invalidateCache(address: string): void {
        this.cache.delete(address.toLowerCase())
    }

    /**
     * Clear entire cache
     */
    clearCache(): void {
        this.cache.clear()
    }

    /**
     * Get from cache if valid
     */
    private getFromCache(address: string): HumanPassportVerification | null {
        const cached = this.cache.get(address)
        if (!cached) return null

        // Check if expired
        if (Date.now() - cached.fetchedAt > CACHE_TTL_MS) {
            this.cache.delete(address)
            return null
        }

        return cached.data
    }

    /**
     * Set in cache
     */
    private setInCache(address: string, data: HumanPassportVerification): void {
        this.cache.set(address, {
            data,
            fetchedAt: Date.now(),
        })
    }

    /**
     * Transform raw API response to verification result
     */
    private transformResponse(data: RawScoreResponse): HumanPassportVerification {
        return {
            address: data.address,
            score: parseFloat(data.score) || 0,
            passingScore: data.passing_score,
            threshold: parseFloat(data.threshold) || 20,
            stamps: Object.keys(data.stamps || {}),
            lastScoreTimestamp: data.last_score_timestamp,
            expirationTimestamp: data.expiration_timestamp,
            verifiedAt: Date.now(),
        }
    }
}

export default HumanPassportProvider
