import axios, { AxiosInstance, AxiosResponse } from "axios"
import log from "@/utilities/logger"
import { NomisImportOptions } from "../providers/nomisIdentityProvider"

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

const DEFAULT_BASE_URL =
    process.env.NOMIS_API_BASE_URL || "https://api.nomis.cc"
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
            headers["X-API-Key"] = process.env.NOMIS_API_KEY
        }

        if (process.env.NOMIS_CLIENT_ID) {
            headers["X-ClientId"] = process.env.NOMIS_CLIENT_ID
        }

        this.http = axios.create({
            baseURL: DEFAULT_BASE_URL,
            timeout: Number(process.env.NOMIS_API_TIMEOUT_MS || 10_000),
            headers,
        })
    }

    static getInstance(): NomisApiClient {
        if (!NomisApiClient.instance) {
            NomisApiClient.instance = new NomisApiClient()
        }

        return NomisApiClient.instance
    }

    async getWalletScore(
        address: string,
        options: NomisImportOptions = {},
    ): Promise<NomisWalletScorePayload> {
        if (!address) {
            throw new Error("Wallet address is required to fetch Nomis score")
        }

        const timeout = 30000
        const chain = options.chain ?? "evm"

        const normalized =
            chain === "evm" ? address.trim().toLowerCase() : address

        const params = new URLSearchParams()

        let url: string

        if (chain === "evm") {
            const scoredChains = [1, 10, 56, 137, 5000, 8453, 42161, 59144]

            params.set(
                "scoreType",
                String(options.scoreType ?? this.defaultScoreType),
            )
            params.set("nonce", String(options.nonce ?? 0))
            params.set(
                "deadline",
                String(options.deadline ?? this.computeDeadline()),
            )

            scoredChains.forEach(ch => {
                params.append("ScoredChains", String(ch))
            })

            url = `/api/v1/crosschain-score/wallet/${normalized}/score`
        } else {
            url = `/api/v1/solana/wallet/${normalized}/score`
        }

        let response: AxiosResponse<NomisApiResponse<NomisWalletScorePayload>>

        try {
            if (chain === "evm") {
                response = await this.http.get(url, { params, timeout })
            } else {
                response = await this.http.get(url, { timeout })
            }
        } catch (error) {
            log.error(
                `[NomisApiClient] Failed to fetch score for ${chain}: ${normalized}: ${error}`,
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
}
