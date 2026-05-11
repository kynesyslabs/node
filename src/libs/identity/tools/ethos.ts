import axios, { AxiosInstance } from "axios"
import log from "@/utilities/logger"
import { EthosScorePayload } from "./types"
import { ETHOS_API_BASE_URL, ETHOS_API_TIMEOUT_MS } from "./constants"

// backward-compatible re-export
export type { EthosScorePayload } from "./types"

export class EthosApiClient {
    private static instance: EthosApiClient
    private readonly http: AxiosInstance

    private constructor() {
        this.http = axios.create({
            baseURL: ETHOS_API_BASE_URL,
            timeout: ETHOS_API_TIMEOUT_MS,
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
        } catch (error) {
            const axiosError = error as { response?: { status?: number }; code?: string }

            // Check if it's a 404 - wallet has no Ethos profile
            if (axiosError.response?.status === 404) {
                throw new Error(
                    "This wallet does not have an Ethos profile. Please create one at ethos.network first.",
                )
            }

            const statusCode = axiosError.response?.status ?? "unknown"
            const errorType = axiosError.code === "ECONNREFUSED"
                ? "connection_refused"
                : axiosError.code === "ETIMEDOUT"
                    ? "timeout"
                    : "api_error"
            log.error(
                `[EthosApiClient] API request failed: status=${statusCode}, type=${errorType}`,
            )
            throw new Error("Failed to fetch Ethos score")
        }
    }
}
