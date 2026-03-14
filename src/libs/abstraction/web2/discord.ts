import { Web2ProofParser } from "./parsers"
import { SigningAlgorithm } from "@kynesyslabs/demosdk/types"
import { Discord } from "@/libs/identity/tools/discord"

export class DiscordProofParser extends Web2ProofParser {
    private static instance: DiscordProofParser
    discord: Discord

    constructor() {
        super()
        this.discord = Discord.getInstance()
    }

    private parseDiscordMessageUrl(proofUrl: string): {
        channelId: string
        messageId: string
    } {
        const { channelId, messageId } =
            this.discord.extractMessageDetails(proofUrl)
        return { channelId, messageId }
    }

    async getMessageFromUrl(messageUrl: string) {
        return await this.discord.getMessageByUrl(messageUrl)
    }

    async readData(proofUrl: string): Promise<{
        message: string
        signature: string
        type: SigningAlgorithm
    }> {
        this.verifyProofFormat(proofUrl, "discord")

        // Validate and fetch via shared client
        this.parseDiscordMessageUrl(proofUrl)
        const msg = await this.discord.getMessageByUrl(proofUrl)
        const content = (msg?.content as string) || ""

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
