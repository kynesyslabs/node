import { Web2ProofParser } from "./parsers"
import { Twitter } from "@/libs/identity/tools/twitter"
import { SigningAlgorithm } from "@kynesyslabs/demosdk/types"

export class XProofParser extends Web2ProofParser {
    private static instance: XProofParser
    x: Twitter

    constructor() {
        super()
        this.x = Twitter.getInstance()
    }

    async readData(tweetUrl: string): Promise<{
        message: string
        signature: string
        type: SigningAlgorithm
    }> {
        this.verifyProofFormat(tweetUrl, "x")
        // INFO: Get the tweet ID from the URL
        const { username, tweetId } = this.x.extractTweetDetails(tweetUrl)
        const tweet = await this.x.getTweetById(tweetId)

        if (!tweet) {
            throw new Error("Failed to get tweet")
        }

        if (tweet.author.screen_name !== username) {
            throw new Error("Tweet does not belong to the provided user")
        }

        // INFO: Parse and return the payload
        const payload = this.parsePayload(tweet.text)

        if (!payload) {
            throw new Error("Invalid proof format")
        }

        return payload
    }

    static async getInstance() {
        if (!this.instance) {
            this.instance = new XProofParser()
        }

        return this.instance
    }
}
