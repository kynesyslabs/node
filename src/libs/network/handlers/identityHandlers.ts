import { Twitter } from "../../identity/tools/twitter"
import { Discord } from "../../identity/tools/discord"
import { UDIdentityManager } from "../../blockchain/gcr/gcr_routines/udIdentityManager"
import ensureGCRForUser from "../../blockchain/gcr/gcr_routines/ensureGCRForUser"
import HandleGCR from "../../blockchain/gcr/handleGCR"
import type { Tweet } from "@kynesyslabs/demosdk/types"
import type { DiscordMessage } from "../../identity/tools/discord"
import log from "src/utilities/logger"
import type { NodeCallHandler } from "./types"

export const identityHandlers: Record<string, NodeCallHandler> = {
    getAddressInfo: async (data, response) => {
        if (!data.address) {
            response.result = 400
            response.response = "No address specified"
            return response
        }
        try {
            const nStat = await ensureGCRForUser(data.address)
            response.response = nStat
        } catch (error) {
            response.result = 400
            response.response = "error"
            response.extra = error
        }
        return response
    },

    getAddressNonce: async (data, response) => {
        if (!data.address) {
            response.result = 400
            response.response = "No address specified"
            return response
        }
        const nStat = await ensureGCRForUser(data.address)
        response.response = nStat.nonce
        return response
    },

    getNativeStatus: async (data, _response) => {
        return await HandleGCR.getNativeStatus(
            data.address,
            ...(data.options ? [data.options] : []),
        )
    },

    getNativeProperties: async (data, _response) => {
        return await HandleGCR.getNativeProperties(
            data.address,
            ...(data.options ? [data.options] : []),
        )
    },

    getNativeSubnetsTxs: async (data, _response) => {
        return await HandleGCR.getNativeSubnetsTxs(
            data.subnetId,
            ...(data.options ? [data.options] : []),
        )
    },

    getTweet: async (data, response) => {
        if (!data.tweetUrl) {
            response.result = 400
            response.response = "No tweet URL specified"
            return response
        }

        const twitter = Twitter.getInstance()
        let tweet: Tweet = null

        try {
            tweet = await twitter.getTweetByUrl(data.tweetUrl)
        } catch (error) {
            response.result = 400
            response.response = {
                success: false,
                error: "Failed to get tweet",
            }
            return response
        }

        response.result = tweet ? 200 : 400
        if (tweet) {
            const tweetData = {
                id: (tweet as any).id,
                created_at: tweet.created_at,
                text: tweet.text,
                username: tweet.author.screen_name,
                userId: tweet.author.rest_id,
            }
            response.response = {
                tweet: tweetData,
                success: true,
            }
        } else {
            response.response = {
                success: false,
                error: "Failed to get tweet",
            }
        }
        return response
    },

    getDiscordMessage: async (data, response) => {
        if (!data.discordUrl) {
            response.result = 400
            response.response = "No Discord URL specified"
            return response
        }

        let discord: Discord
        try {
            discord = Discord.getInstance()
        } catch (e) {
            response.result = 500
            response.response = {
                success: false,
                error: "Discord not configured",
            }
            return response
        }

        let message: DiscordMessage | null = null

        try {
            message = await discord.getMessageByUrl(data.discordUrl)
        } catch (error) {
            response.result = 400
            response.response = {
                success: false,
                error: "Failed to get Discord message",
            }
            return response
        }

        response.result = message ? 200 : 400
        if (message) {
            let guildIdFromUrl: string | undefined
            let channelIdFromUrl: string | undefined
            let messageIdFromUrl: string | undefined

            try {
                const details = discord.extractMessageDetails(
                    data.discordUrl,
                )
                guildIdFromUrl = details.guildId
                channelIdFromUrl = details.channelId
                messageIdFromUrl = details.messageId
            } catch {
                // non-fatal, e.g. if URL format was unexpected
            }

            const payload = {
                id: message.id,
                timestamp: message.timestamp,
                authorUsername: message.author?.username ?? null,
                authorId: message.author?.id ?? null,
                channelId: message.channel_id ?? channelIdFromUrl ?? null,
                guildId:
                    (message as any).guild_id ?? guildIdFromUrl ?? null,
            }

            response.response = {
                message: payload,
                success: true,
            }
        } else {
            response.response = {
                success: false,
                error: "Failed to get Discord message",
            }
        }
        return response
    },

    resolveUdDomain: async (data, response) => {
        try {
            const res = await UDIdentityManager.resolveUDDomain(data.domain)
            if (res) {
                response.response = res
            }
        } catch (error) {
            log.error(
                "[manageNodeCall] Failed to resolve web3 domain: " + error,
            )
            response.result = 400
            response.response = {
                success: false,
                error: "Failed to resolve web3 domain",
            }
        }
        return response
    },
}
