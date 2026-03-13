import axios, { AxiosInstance, AxiosResponse } from "axios"
import { URL } from "url"
import log from "@/utilities/logger"
import { Config } from "src/config"
import { DiscordMessage } from "./types"
import { DISCORD_API_TIMEOUT_MS } from "./constants"

// backward-compatible re-export
export type { DiscordMessage } from "./types"

export class Discord {
    private static instance: Discord
    private axios: AxiosInstance

    readonly api_url = Config.getInstance().identity.discordApiUrl
    readonly bot_token = Config.getInstance().identity.discordBotToken

    private constructor() {
        if (!this.bot_token) {
            throw new Error("Missing DISCORD_BOT_TOKEN env variable")
        }

        // Validate host to avoid accidental redirection to internal networks
        const parsed = new URL(this.api_url)
        const host = parsed.hostname.toLowerCase()
        const isTrusted =
            host.endsWith(".discord.com") || host === "discord.com"

        if (!isTrusted) {
            throw new Error(`Untrusted DISCORD_API_URL host: ${host}`)
        }

        this.axios = axios.create({
            baseURL: this.api_url,
            headers: {
                Authorization: `Bot ${this.bot_token}`,
                "Content-Type": "application/json",
            },
            timeout: DISCORD_API_TIMEOUT_MS,
        })
    }

    // Extracts IDs from a Discord message URL
    extractMessageDetails(messageUrl: string): {
        guildId: string
        channelId: string
        messageId: string
    } {
        try {
            const url = new URL(messageUrl)

            const host = url.hostname.toLowerCase()
            const isDiscordHost =
                host === "discord.com" ||
                host.endsWith(".discord.com") ||
                host === "discordapp.com" ||
                host.endsWith(".discordapp.com")

            if (!isDiscordHost) {
                throw new Error(
                    "URL host must be discord.com or discordapp.com (including ptb/canary).",
                )
            }

            const parts = url.pathname.split("/").filter(Boolean)

            if (parts.length !== 4 || parts[0] !== "channels") {
                throw new Error("Invalid Discord message URL format")
            }

            const [_, guildId, channelId, messageId] = parts

            if (
                !this.isSnowflake(guildId) ||
                !this.isSnowflake(channelId) ||
                !this.isSnowflake(messageId)
            ) {
                throw new Error(
                    "One or more IDs are not valid Discord snowflakes",
                )
            }

            return { guildId, channelId, messageId }
        } catch (err) {
            log.warning("Failed to extract details from Discord URL")
            throw new Error(
                `Invalid Discord message URL: ${
                    err instanceof Error ? err.message : "Unknown error"
                }`,
            )
        }
    }

    // Basic snowflake validator (numeric string up to 19-20 digits)
    private isSnowflake(id: string): boolean {
        return /^\d{17,20}$/.test(id)
    }

    // Generic GET with simple rate-limit handling
    private async get<T>(url: string, delay = 0): Promise<AxiosResponse<T>> {
        if (delay > 0) {
            await new Promise(r => setTimeout(r, delay))
        }

        try {
            return await this.axios.get<T>(url)
        } catch (e: any) {
            if (e?.response?.status === 429) {
                const retryAfter = Number(
                    e.response.headers["retry-after"] ?? 1,
                )
                await new Promise(r =>
                    setTimeout(r, Math.ceil(retryAfter * 1000)),
                )
                return await this.axios.get<T>(url)
            }
            throw e
        }
    }

    // Fetch a message by channel & message ID
    async getMessageById(
        channelId: string,
        messageId: string,
    ): Promise<DiscordMessage> {
        const res = await this.get<DiscordMessage>(
            `/channels/${channelId}/messages/${messageId}`,
        )
        if (res.status === 200) return res.data
        throw new Error("Failed to get Discord message")
    }

    // Fetch a message by full URL
    async getMessageByUrl(messageUrl: string): Promise<DiscordMessage> {
        const { channelId, messageId } = this.extractMessageDetails(messageUrl)
        return await this.getMessageById(channelId, messageId)
    }

    static getInstance() {
        if (!Discord.instance) {
            Discord.instance = new Discord()
        }
        return Discord.instance
    }
}
