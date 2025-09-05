import axios, { AxiosInstance, AxiosResponse } from "axios"
import { URL } from "url"

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

export class Discord {
    private static instance: Discord
    private axios: AxiosInstance

    api_url = process.env.DISCORD_API_URL ?? "https://discord.com/api/v10"
    bot_token = process.env.DISCORD_BOT_TOKEN as string

    private constructor() {
        if (!this.bot_token) {
            throw new Error("Missing DISCORD_BOT_TOKEN env variable")
        }

        this.axios = axios.create({
            baseURL: this.api_url,
            headers: {
                Authorization: `Bot ${this.bot_token}`,
                "Content-Type": "application/json",
            },
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

            // Normalize hosts like discordapp.com -> discord.com
            if (
                !/discord\.com$/i.test(url.host) &&
                !/discordapp\.com$/i.test(url.host)
            ) {
                throw new Error(
                    "URL host must be discord.com or discordapp.com",
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
            console.error(`Failed to extract details from URL: ${messageUrl}`)
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
