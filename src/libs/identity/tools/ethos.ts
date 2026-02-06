import axios, { AxiosInstance } from "axios"
import log from "@/utilities/logger"

export interface EthosScorePayload {
    score: number
    profileId?: number
    displayName?: string
    username?: string
}

interface EthosScoreResponse {
    score: number
}

interface EthosProfileResponse {
    id: number
    profileId: number
    displayName?: string
    username?: string
    score: number
    status: string
    avatarUrl?: string
}

const BASE_URL = "https://api.ethos.network/api/v2"

export class EthosApiClient {
    private static instance: EthosApiClient
    private readonly http: AxiosInstance

    private constructor() {
        this.http = axios.create({
            baseURL: BASE_URL,
            timeout: 10_000,
            headers: {
                Accept: "application/json",
            },
        })
    }

    static getInstance(): EthosApiClient {
        if (!EthosApiClient.instance) {
            EthosApiClient.instance = new EthosApiClient()
        }

        return EthosApiClient.instance
    }

    async getScore(address: string): Promise<EthosScorePayload> {
        if (!address) {
            throw new Error("Wallet address is required to fetch Ethos score")
        }

        const normalized = address.trim().toLowerCase()

        try {
            const userResponse = await this.http.get<{
                id: number
                profileId: number | null
                displayName?: string
                username?: string
                score: number
                status: string
            }>(`/user/by/address/${normalized}`)

            const score = userResponse.data?.score
            if (score === undefined || score === null) {
                throw new Error("Ethos API returned no score data")
            }

            const result: EthosScorePayload = {
                score,
                profileId: userResponse.data.profileId ?? undefined,
                displayName: userResponse.data.displayName,
                username: userResponse.data.username ?? undefined,
            }

            return result
        } catch (error: any) {
            // Check if it's a 404 - wallet has no Ethos profile
            if (error?.response?.status === 404) {
                throw new Error(
                    "This wallet does not have an Ethos profile. Please create one at ethos.network first.",
                )
            }

            const statusCode = error?.response?.status ?? "unknown"
            const errorType = error?.code === "ECONNREFUSED"
                ? "connection_refused"
                : error?.code === "ETIMEDOUT"
                    ? "timeout"
                    : "api_error"
            log.error(
                `[EthosApiClient] API request failed: status=${statusCode}, type=${errorType}`,
            )
            throw new Error("Failed to fetch Ethos score")
        }
    }
}
