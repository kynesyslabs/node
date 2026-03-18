import axios, { AxiosInstance, AxiosResponse } from "axios"
import log from "@/utilities/logger"
import { Config } from "src/config"
import { NomisImportOptions } from "../providers/nomisIdentityProvider"
import {
    NomisWalletScorePayload,
    NomisApiResponse,
} from "./types"
import {
    NOMIS_SCORED_CHAINS,
    NOMIS_WALLET_SCORE_TIMEOUT_MS,
} from "./constants"

// backward-compatible re-exports
export type { NomisWalletScorePayload, NomisScoreRequestOptions } from "./types"

const DEFAULT_BASE_URL = Config.getInstance().identity.nomisApiBaseUrl
const DEFAULT_SCORE_TYPE = Config.getInstance().identity.nomisDefaultScoreType
const DEFAULT_DEADLINE_OFFSET_SECONDS = Config.getInstance().identity.nomisDefaultDeadlineOffsetSeconds

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

        const identityConfig = Config.getInstance().identity

        if (identityConfig.nomisApiKey) {
            headers["X-API-Key"] = identityConfig.nomisApiKey
        }

        if (identityConfig.nomisClientId) {
            headers["X-ClientId"] = identityConfig.nomisClientId
        }

        this.http = axios.create({
            baseURL: DEFAULT_BASE_URL,
            timeout: identityConfig.nomisApiTimeoutMs,
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

        const timeout = NOMIS_WALLET_SCORE_TIMEOUT_MS
        const chain = options.chain ?? "evm"

        const normalized =
            chain === "evm" ? address.trim().toLowerCase() : address

        const params = new URLSearchParams()

        let url: string

        if (chain === "evm") {
            const scoredChains = NOMIS_SCORED_CHAINS

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
