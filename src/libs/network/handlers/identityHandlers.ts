import { Twitter } from "../../identity/tools/twitter"
import { Discord } from "../../identity/tools/discord"
import {
    fetchDomainProof,
    DOMAIN_PROOF_PATH,
} from "../../abstraction/web2/domain"
import { UDIdentityManager } from "../../blockchain/gcr/gcr_routines/udIdentityManager"
import ensureGCRForUser from "../../blockchain/gcr/gcr_routines/ensureGCRForUser"
import type { Tweet } from "@kynesyslabs/demosdk/types"
import type { DiscordMessage } from "../../identity/tools/discord"
import log from "src/utilities/logger"
import type { NodeCallHandler } from "./types"
import GCR from "@/libs/blockchain/gcr/gcr"

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
            response.extra = {
                message: error instanceof Error ? error.message : String(error),
            }
        }
        return response
    },

    getAddressNonce: async (data, response) => {
        if (!data.address) {
            response.result = 400
            response.response = "No address specified"
            return response
        }
        response.response = await GCR.getAccountNonce(data.address)
        return response
    },

    getNativeSubnetsTxs: async (data, _response) => {
        return await GCR.getNativeSubnetsTxs(
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
                const details = discord.extractMessageDetails(data.discordUrl)
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
                guildId: (message as any).guild_id ?? guildIdFromUrl ?? null,
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

    getDomainProof: async (data, response) => {
        if (!data.url) {
            response.result = 400
            response.response = { success: false, error: "No url specified" }
            return response
        }

        let parsed: URL
        try {
            parsed = new URL(data.url)
        } catch {
            response.result = 400
            response.response = { success: false, error: "Invalid url" }
            return response
        }

        if (parsed.protocol !== "https:") {
            response.result = 400
            response.response = {
                success: false,
                error: "Proof URL must use https",
            }
            return response
        }

        if (parsed.pathname !== DOMAIN_PROOF_PATH) {
            response.result = 400
            response.response = {
                success: false,
                error: `Proof must be hosted at ${DOMAIN_PROOF_PATH}`,
            }
            return response
        }

        // Default https port only — consistent with verifyWeb2Proof / the parser.
        if (parsed.port !== "") {
            response.result = 400
            response.response = {
                success: false,
                error: "Proof URL must use the default https port",
            }
            return response
        }

        try {
            const { hostname, body } = await fetchDomainProof(data.url)
            response.result = 200
            response.response = { success: true, hostname, body }
        } catch (error) {
            log.error("[getDomainProof] failed to fetch domain proof", error)
            response.result = 400
            response.response = {
                success: false,
                error: "Failed to fetch domain proof",
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
