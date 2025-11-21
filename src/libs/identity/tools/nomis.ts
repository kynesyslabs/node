import axios, { AxiosInstance, AxiosResponse } from "axios"
import log from "@/utilities/logger"

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

interface NomisApiResponse<T> {
    succeeded: boolean
    messages?: string[]
    data: T
}

const DEFAULT_BASE_URL = process.env.NOMIS_API_BASE_URL || "https://api.nomis.cc"
const DEFAULT_SCORE_TYPE = Number(process.env.NOMIS_DEFAULT_SCORE_TYPE || 0)
const DEFAULT_DEADLINE_OFFSET_SECONDS = Number(
    process.env.NOMIS_DEFAULT_DEADLINE_OFFSET_SECONDS || 3600,
)

export class NomisApiClient {
    private static instance: NomisApiClient
    private readonly http: AxiosInstance
    private readonly defaultScoreType: number
    private readonly defaultDeadlineOffset: number
    private readonly useMockData: boolean

    private constructor() {
        this.defaultScoreType = DEFAULT_SCORE_TYPE
        this.defaultDeadlineOffset = DEFAULT_DEADLINE_OFFSET_SECONDS

        const headers: Record<string, string> = {
            Accept: "application/json",
        }

        if (process.env.NOMIS_API_KEY) {
            headers["x-api-key"] = process.env.NOMIS_API_KEY
        }

        if (process.env.NOMIS_API_TOKEN) {
            headers.Authorization = `Bearer ${process.env.NOMIS_API_TOKEN}`
        }

        this.http = axios.create({
            baseURL: DEFAULT_BASE_URL,
            timeout: Number(process.env.NOMIS_API_TIMEOUT_MS || 10_000),
            headers,
        })

        this.useMockData = this.shouldUseMockData()

        if (this.useMockData) {
            log.info(
                "[NomisApiClient] Running in mock mode – API key/token missing. Set NOMIS_USE_MOCKS=false after configuring credentials.",
            )
        }
    }

    static getInstance(): NomisApiClient {
        if (!NomisApiClient.instance) {
            NomisApiClient.instance = new NomisApiClient()
        }

        return NomisApiClient.instance
    }

    async getWalletScore(
        address: string,
        options: NomisScoreRequestOptions = {},
    ): Promise<NomisWalletScorePayload> {
        if (!address) {
            throw new Error("Wallet address is required to fetch Nomis score")
        }

        const normalized = address.trim().toLowerCase()

        const params = {
            scoreType: options.scoreType ?? this.defaultScoreType,
            nonce: options.nonce ?? 0,
            deadline: options.deadline ?? this.computeDeadline(),
        }

        if (this.useMockData) {
            return this.buildMockScore(normalized, params)
        }

        let response: AxiosResponse<NomisApiResponse<NomisWalletScorePayload>>

        try {
            response = await this.http.get(
                `/api/v1/ethereum/wallet/${normalized}/score`,
                { params },
            )
        } catch (error) {
            log.error(
                `[NomisApiClient] Failed to fetch score for ${normalized}: ${error}`,
            )
            throw error
        }

        if (!response?.data?.succeeded || !response.data.data) {
            const reason = response?.data?.messages?.join("; ") || "Unknown"
            throw new Error(`Nomis API returned an empty response: ${reason}`)
        }

        return response.data.data
    }

    private computeDeadline(): number {
        return Math.floor(Date.now() / 1000) + this.defaultDeadlineOffset
    }

    private shouldUseMockData(): boolean {
        const explicitFlag = process.env.NOMIS_USE_MOCKS?.toLowerCase()

        if (explicitFlag === "true") {
            return true
        }

        if (explicitFlag === "false") {
            return false
        }

        return !process.env.NOMIS_API_KEY && !process.env.NOMIS_API_TOKEN
    }

    private buildMockScore(
        address: string,
        params: { scoreType: number; nonce: number; deadline: number },
    ): NomisWalletScorePayload {
        const baseScore = this.deriveDeterministicScore(address)

        return {
            address,
            score: baseScore,
            scoreType: params.scoreType,
            referralCode: "MOCK",
            referrerCode: undefined,
            mintData: {
                mintedScore: Number(baseScore.toFixed(2)),
                deadline: params.deadline,
            },
            stats: {
                scoredAt: new Date().toISOString(),
                walletAge: 365,
                totalTransactions: 42,
                nativeBalanceUSD: baseScore * 10,
                walletTurnoverUSD: baseScore * 25,
            },
        }
    }

    private deriveDeterministicScore(address: string): number {
        const seed = Array.from(address).reduce((acc, char, idx) => {
            const code = char.charCodeAt(0)
            return (acc + code * (idx + 1)) % 10_000
        }, 0)

        const normalizedScore = (seed % 1_000) / 10 // 0 - 100 range with one decimal
        return Number(normalizedScore.toFixed(2))
    }
}
