import axios, { AxiosResponse } from "axios"
import { Tweet } from "@kynesyslabs/demosdk/types"

export class Twitter {
    private static instance: Twitter

    demos_twitter_username = "demosxyz"
    api_key = process.env.RAPID_API_KEY
    api_host = process.env.RAPID_API_HOST
    api_url = "https://" + this.api_host

    /**
     * Extracts tweet details from a Twitter/X URL
     * @param tweetUrl - Twitter/X URL (supports both twitter.com and x.com)
     * @returns Object containing username and tweet ID
     */
    extractTweetDetails(tweetUrl: string): {
        username: string
        tweetId: string
    } {
        try {
            // Normalize URL to handle both twitter.com and x.com
            const normalizedUrl = tweetUrl.replace(
                /^https?:\/\/(www\.)?(twitter\.com|x\.com)/,
                "https://twitter.com",
            )
            const url = new URL(normalizedUrl)
            const pathParts = url.pathname
                .split("/")
                .filter(part => part.length > 0)

            // Tweet URLs follow pattern: twitter.com/username/status/tweetId
            const statusIndex = pathParts.indexOf("status")
            if (
                statusIndex === -1 ||
                statusIndex === 0 ||
                !pathParts[statusIndex + 1]
            ) {
                throw new Error("Invalid tweet URL format")
            }

            const username = pathParts[statusIndex - 1]
            const tweetId = pathParts[statusIndex + 1]

            if (!username || !tweetId) {
                throw new Error(
                    "Invalid tweet URL format - missing username or tweet ID",
                )
            }

            return { username, tweetId }
        } catch (error) {
            console.error(
                `Failed to extract tweet details from URL: ${tweetUrl}`,
            )
            throw new Error(
                `Invalid tweet URL: ${
                    error instanceof Error ? error.message : "Unknown error"
                }`,
            )
        }
    }

    /**
     * @param url - The full URL to make the request to
     *
     * @param data - The data to send with the request (optional)
     * @returns The response from the request
     */
    async makeRequest<T>(url: string): Promise<AxiosResponse<T>> {
        return await axios.get<T>(url, {
            headers: {
                "x-rapidapi-key": this.api_key,
                "x-rapidapi-host": this.api_host,
            },
        })
    }

    async getTweetById(tweetId: string): Promise<Tweet> {
        const res = await this.makeRequest<Tweet>(
            `${this.api_url}/tweet.php?id=${tweetId}`,
        )

        if (res.status === 200) {
            return res.data
        } else {
            throw new Error("Failed to get tweet")
        }
    }

    async getTweetByUrl(tweetUrl: string): Promise<Tweet> {
        const { tweetId } = this.extractTweetDetails(tweetUrl)
        return await this.getTweetById(tweetId)
    }

    async checkFollow(username: string): Promise<boolean> {
        const res = await this.makeRequest<{
            is_follow: boolean
        }>(
            `${this.api_url}/checkfollow.php?user=${username}&follows=${this.demos_twitter_username}`,
        )

        if (res.status === 200) {
            return res.data.is_follow
        } else {
            return false
        }
    }

    static getInstance() {
        if (!Twitter.instance) {
            Twitter.instance = new Twitter()
        }

        return Twitter.instance
    }
}
