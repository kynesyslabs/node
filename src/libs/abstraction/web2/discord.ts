import axios from "axios"
import { Web2ProofParser } from "./parsers"
import { SigningAlgorithm } from "@kynesyslabs/demosdk/types"
import { Discord } from "@/libs/identity/tools/discord"

export class DiscordProofParser extends Web2ProofParser {
    private static instance: DiscordProofParser
    private botToken: string
    discord: Discord

    constructor() {
        super()
        this.discord = Discord.getInstance()
        this.botToken = process.env.DISCORD_BOT_TOKEN ?? ""
    }

    private parseDiscordMessageUrl(proofUrl: string): {
        channelId: string
        messageId: string
    } {
        try {
            const url = new URL(proofUrl)
            const parts = url.pathname.split("/").filter(Boolean)
            const channelsIndex = parts.indexOf("channels")
            if (channelsIndex === -1 || parts.length < channelsIndex + 4) {
                throw new Error("Invalid Discord message URL format")
            }

            const channelId = parts[channelsIndex + 2]
            const messageId = parts[channelsIndex + 3]

            return { channelId, messageId }
        } catch (error) {
            console.error(error)
            throw new Error("Failed to extract Discord message details")
        }
    }

    async getMessageFromUrl(messageUrl: string) {
        const apiUrl = "https://discord.com/api/v10"
        const parts = messageUrl.split("/").filter(Boolean)
        const channelId = parts[5]
        const messageId = parts[6]

        const res = await axios.get(
            `${apiUrl}/channels/${channelId}/messages/${messageId}`,
            {
                headers: { Authorization: `Bot ${this.botToken}` },
            },
        )

        return res.data
    }

    async readData(proofUrl: string): Promise<{
        message: string
        signature: string
        type: SigningAlgorithm
    }> {
        this.verifyProofFormat(proofUrl, "discord")

        const { channelId, messageId } = this.parseDiscordMessageUrl(proofUrl)

        const res = await axios.get(
            `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`,
            {
                headers: {
                    Authorization: `Bot ${this.botToken}`,
                },
            },
        )

        if (res.status !== 200) {
            throw new Error(`Failed to fetch Discord message: ${res.status}`)
        }

        const content = (res.data?.content as string) || ""

        const payload = this.parsePayload(content)
        if (!payload) {
            throw new Error("Invalid proof format")
        }

        return payload
    }

    static async getInstance() {
        if (!this.instance) {
            this.instance = new DiscordProofParser()
        }

        return this.instance
    }
}
