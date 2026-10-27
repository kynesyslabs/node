import { Web2ProofParser, Web2Claim, sameHandle, sameId } from "./parsers"
import { Twitter } from "@/libs/identity/tools/twitter"
import { SigningAlgorithm } from "@kynesyslabs/demosdk/types"

export class TwitterProofParser extends Web2ProofParser {
    private static instance: TwitterProofParser
    twitter: Twitter

    constructor() {
        super()
        this.twitter = Twitter.getInstance()
    }

    async readData(
        tweetUrl: string,
        claim: Web2Claim,
    ): Promise<{
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

        if (!sameHandle(tweet.author.screen_name, username)) {
            throw new Error("Tweet does not belong to the provided user")
        }

        // The claimed handle and id come from the payload and are what gets
        // stored and rewarded, so the post has to be by that very account.
        if (!sameHandle(tweet.author.screen_name, claim?.username)) {
            throw new Error("Tweet author does not match the claimed username")
        }

        if (!sameId(tweet.author.rest_id, claim?.userId)) {
            throw new Error("Tweet author does not match the claimed user id")
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
