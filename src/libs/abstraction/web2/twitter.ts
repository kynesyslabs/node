import { Web2ProofParser } from "./parsers"
import { Twitter } from "@/libs/identity/tools/twitter"
import { SigningAlgorithm } from "@kynesyslabs/demosdk/types"

export class TwitterProofParser extends Web2ProofParser {
    private static instance: TwitterProofParser
    twitter: Twitter

    constructor() {
        super()
        this.twitter = Twitter.getInstance()
    }

    async readData(tweetUrl: string): Promise<{
        message: string
        signature: string
        type: SigningAlgorithm
    }> {
        this.verifyProofFormat(tweetUrl, "twitter")
        // INFO: Get the tweet ID from the URL
        const { username, tweetId } = this.twitter.extractTweetDetails(tweetUrl)
        const tweet = await this.twitter.getTweetById(tweetId)

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
            this.instance = new TwitterProofParser()
        }

        return this.instance
    }
}
