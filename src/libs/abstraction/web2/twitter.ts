import fs from "fs"
import { Scraper } from "@the-convocation/twitter-scraper"
import { getSharedState } from "@/utilities/sharedState"
import { Cookie } from "tough-cookie"
import log from "@/utilities/logger"
import { Web2ProofParser } from "./parsers"

export class TwitterProofParser extends Web2ProofParser {
    private static instance: TwitterProofParser
    scraper: Scraper

    constructor() {
        super()
        this.scraper = new Scraper()
    }

    getTweetDetails(tweetUrl: string): { username: string; tweetId: string } {
        try {
            // Parse URL and remove any query parameters
            const url = new URL(tweetUrl)
            const pathParts = url.pathname.split("/")

            // Tweet URLs follow pattern twitter.com/username/status/tweetId
            const statusIndex = pathParts.indexOf("status")
            if (statusIndex === -1 || !pathParts[statusIndex + 1]) {
                throw new Error("Invalid tweet URL format")
            }

            // Username is the part before 'status'
            const username = pathParts[statusIndex - 1]
            if (!username) {
                throw new Error("Invalid tweet URL format - username not found")
            }

            return {
                username: username,
                tweetId: pathParts[statusIndex + 1],
            }
        } catch (error) {
            console.error(error)
            throw new Error("Failed to extract tweet details")
        }
    }

    async loadCookies() {
        // INFO: Load cookies from file
        log.debug("🐦 Trying to load cookies from file")
        if (fs.existsSync(getSharedState.twitterCookieFile)) {
            log.debug("🐦 Twitter cookie file found, parsing ...")
            const cookieDump = fs.readFileSync(
                getSharedState.twitterCookieFile,
                "utf8",
            )

            if (cookieDump) {
                const parsed: any[] = JSON.parse(cookieDump)
                const cookies = parsed.map(data => Cookie.fromJSON(data))
                await this.scraper.setCookies(cookies)
            }
        }

        const loggedIn = await this.scraper.isLoggedIn()
        if (loggedIn) {
            log.debug("🐦 Successfully loaded cookies from file")
        }

        return loggedIn
    }

    async login() {
        // INFO: Try to load cookies from file
        const loggedInFromCookies = await this.loadCookies()
        if (loggedInFromCookies) {
            return true
        }

        log.warning(
            "🐦 Failed to load cookies from file, trying login using credentials",
        )
        // INFO: Try to login with credentials
        log.debug("🐦 Trying to login with credentials")
        const username = process.env.TWITTER_USERNAME
        const password = process.env.TWITTER_PASSWORD
        const email = process.env.TWITTER_EMAIL

        const missing = [
            !username && "username",
            !password && "password",
            !email && "email",
        ].filter(Boolean)

        if (missing.length) {
            throw new Error(
                `Missing Twitter credentials: ${missing.join(", ")}`,
            )
        }

        await this.scraper.login(username, password, email)

        const loggedIn = await this.scraper.isLoggedIn()
        if (!loggedIn) {
            throw new Error("Unable to authenticate with Twitter")
        }

        log.debug("🐦 Successfully logged in with credentials")
        const cookies = await this.scraper.getCookies()

        // INFO: Save cookies to file
        fs.writeFileSync(
            getSharedState.twitterCookieFile,
            JSON.stringify(cookies, null, 2),
        )

        return loggedIn
    }

    async getTweet(tweetUrl: string) {
        const { tweetId } = this.getTweetDetails(tweetUrl)

        try {
            const tweet = await this.scraper.getTweet(tweetId)
            return {
                success: true,
                tweet: tweet,
            }
        } catch (error) {
            console.error(error)
            return {
                success: false,
                error: "Failed to get tweet",
            }
        }
    }

    async readData(tweetUrl: string): Promise<{
        message: string
        signature: string
        publicKey: string
    }> {
        this.verifyProofFormat(tweetUrl, "twitter")
        // INFO: Get the tweet ID from the URL
        const { username, tweetId } = this.getTweetDetails(tweetUrl)
        const tweet = await this.scraper.getTweet(tweetId)

        if (tweet.username !== username) {
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

        try {
            await this.instance.login()
        } catch (error) {
            console.error(error)
            // do what?
        }

        return this.instance
    }
}
