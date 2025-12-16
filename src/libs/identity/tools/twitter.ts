import * as fs from "fs"
import axios, { AxiosResponse } from "axios"
import {
    Tweet,
    TwitterTimelineResponse,
    TwitterFollowersResponse,
} from "@kynesyslabs/demosdk/types"
import log from "@/utilities/logger"

class TwitterBotDetector {
    constructor(
        private timelineData: TwitterTimelineResponse,
        private followersData: TwitterFollowersResponse,
        private username: string,
    ) {
        this.timelineData = timelineData
        this.followersData = followersData
    }

    detectBot(): boolean {
        let userScore = 0

        // Profile Analysis
        const verificationScore = this.checkVerification()
        log.info(`Verification score: ${verificationScore}`)
        userScore += verificationScore
        const usernamePatternScore = this.checkUsernamePattern()
        log.info(`Username pattern score: ${usernamePatternScore}`)
        userScore += usernamePatternScore
        const bioContentScore = this.checkBioContent()
        log.info(`Bio content score: ${bioContentScore}`)
        userScore += bioContentScore
        const profileCompletenessScore = this.checkProfileCompleteness()
        log.info(`Profile completeness score: ${profileCompletenessScore}`)
        userScore += profileCompletenessScore

        // Activity Pattern Analysis
        const timingAnomaliesScore = this.checkTimingAnomalies()
        log.info(`Timing anomalies score: ${timingAnomaliesScore}`)
        userScore += timingAnomaliesScore
        const contentPatternsScore = this.checkContentPatterns()
        log.info(`Content patterns score: ${contentPatternsScore}`)
        userScore += contentPatternsScore
        const accountAgeActivityScore = this.checkAccountAgeActivity()
        log.info(`Account age activity score: ${accountAgeActivityScore}`)
        userScore += accountAgeActivityScore
        // const engagementAnomaliesScore = this.checkEngagementAnomalies()
        // log.info(`Engagement anomalies score: ${engagementAnomaliesScore}`)
        // userScore += engagementAnomaliesScore

        // Followers Analysis
        const followersScore = this.checkFollowers()
        log.info(`Followers score: ${followersScore}`)
        userScore += followersScore

        // Critical Indicators
        const quotaLimitMessagesScore = this.checkQuotaLimitMessages()
        log.info(`Quota limit messages score: ${quotaLimitMessagesScore}`)
        userScore += quotaLimitMessagesScore
        log.info(`Bot score: ${userScore}`)

        return userScore >= 15 // Likely Bot threshold
    }

    private checkVerification(): number {
        return this.timelineData.user.blue_verified ? -8 : 0
    }

    private checkUsernamePattern(): number {
        return this.checkUsernamePatternGeneric(
            this.username,
            this.timelineData.user.name,
        )
    }

    private checkBioContent(): number {
        return this.checkBioContentGeneric(this.timelineData.user.desc)
    }

    private checkProfileCompleteness(): number {
        return this.checkProfileCompletenessGeneric({
            avatar: this.timelineData.user.avatar,
            header_image: this.timelineData.user.header_image,
            desc: this.timelineData.user.desc,
            friends: this.timelineData.user.friends,
            sub_count: this.timelineData.user.sub_count,
        })
    }

    private checkFollowers(): number {
        if (
            !this.followersData.followers ||
            this.followersData.followers.length === 0
        ) {
            return 0
        }

        let suspiciousFollowers = 0
        const followers = this.followersData.followers

        for (const follower of followers) {
            let followerScore = 0

            // Check username pattern
            followerScore += this.checkUsernamePatternGeneric(
                follower.screen_name,
                follower.name,
            )

            // Check bio content
            followerScore += this.checkBioContentGeneric(follower.description)

            // Check profile completeness
            followerScore += this.checkProfileCompletenessGeneric({
                avatar: follower.profile_image,
                header_image: undefined,
                desc: follower.description,
                friends: follower.friends_count,
                sub_count: follower.followers_count,
            })

            // If follower scores positive on any check, count as suspicious
            if (followerScore > 0) {
                suspiciousFollowers++
            }
        }

        const suspiciousPercentage = suspiciousFollowers / followers.length

        // If N% or more followers are suspicious, add 6 points
        if (suspiciousPercentage >= 0.6) {
            return 10
        }

        return 0
    }

    private checkUsernamePatternGeneric(
        username: string,
        displayName: string,
    ): number {
        const cleanUsername = (username || "").trim()
        const cleanDisplayName = (displayName || "").trim()

        let score = 0

        // Check if display name has two names and first 3 characters of each are in username
        const nameParts = cleanDisplayName.split(/\s+/)
        if (nameParts.length === 2) {
            const firstName = nameParts[0]
            const lastName = nameParts[1]

            // Get first 3 characters of each name (case sensitive)
            if (firstName.length >= 3 && lastName.length >= 3) {
                const firstThree = firstName.substring(0, 3)
                const lastThree = lastName.substring(0, 3)

                // Check if both 3-character prefixes are in username (case sensitive)
                if (
                    cleanUsername.includes(firstThree) &&
                    cleanUsername.includes(lastThree)
                ) {
                    score = 6
                }
            }
        }

        // Check if username ends with 4 digits
        if (cleanUsername.match(/[0-9]{5}$/)) {
            score = 6
        }

        return score
    }

    private checkBioContentGeneric(bio: string): number {
        if (!bio) return 0

        const normalizedBio = bio.toLowerCase()
        let score = 0

        // Check for suspicious keywords
        const suspiciousKeywords = ["nexyai.io", "$fan", "maxi"]

        for (const keyword of suspiciousKeywords) {
            if (normalizedBio.includes(keyword)) {
                score += 5
                break // Only count once
            }
        }

        // Check for excessive emoji sequences (3+ consecutive emojis)
        // const emojiPattern =
        //     /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]{3,}/gu
        // if (emojiPattern.test(normalizedBio)) {
        //     score += 5
        // }

        return score
    }

    private checkProfileCompletenessGeneric(profile: {
        avatar?: string
        header_image?: string
        desc?: string
        friends: number
        sub_count: number
    }): number {
        let score = 0

        // Check for default/missing avatar
        if (
            !profile.avatar ||
            profile.avatar.includes("default") ||
            profile.avatar.includes("placeholder")
        ) {
            score += 4
        }

        // Check for missing header image (only if provided)
        // if (profile.header_image !== undefined && !profile.header_image) {
        //     score = 4
        // }

        // Check for empty or generic bio
        // if (!profile.desc || profile.desc.trim().length < 10) {
        //     score = 4
        // }

        // Check follower/following ratio (high following, low followers)
        if (profile.friends > 1000 && profile.sub_count < 100) {
            score = 4
        }

        return score
    }

    private checkTimingAnomalies(): number {
        const timeline = this.timelineData.timeline
        if (timeline.length < 3) return 0

        let score = 0
        const intervals: number[] = []

        // Calculate intervals between tweets
        for (let i = 1; i < timeline.length; i++) {
            const current = new Date(timeline[i].created_at).getTime()
            const previous = new Date(timeline[i - 1].created_at).getTime()
            intervals.push(Math.abs(current - previous))
        }

        // Check for suspiciously regular intervals
        if (intervals.length > 2) {
            const avgInterval =
                intervals.reduce((a, b) => a + b, 0) / intervals.length
            const variance =
                intervals.reduce(
                    (sum, interval) =>
                        sum + Math.pow(interval - avgInterval, 2),
                    0,
                ) / intervals.length

            // Low variance indicates regular posting
            if (variance < avgInterval * 0.1) {
                score += 5
            }
        }

        // Check for 24/7 activity (tweets across all hours)
        const hours = timeline.map(tweet =>
            new Date(tweet.created_at).getHours(),
        )
        const uniqueHours = new Set(hours)
        if (uniqueHours.size > 20) {
            // Active in more than 20 hours
            score += 5
        }

        return score
    }

    private checkContentPatterns(): number {
        const timeline = this.timelineData.timeline
        let score = 0

        // Check for only retweets
        const retweetCount = timeline.filter(
            tweet => tweet.retweeted_tweet,
        ).length
        if (retweetCount > timeline.length * 0.65) {
            log.debug("Retweet count is too high")
            score += 7
        }

        // Check for repetitive text
        // const textCounts = new Map<string, number>()
        // timeline.forEach(tweet => {
        //     const text = tweet.text.toLowerCase().replace(/\s+/g, " ").trim()
        //     textCounts.set(text, (textCounts.get(text) || 0) + 1)
        // })

        // const duplicateTexts = Array.from(textCounts.values()).filter(
        //     count => count > 1,
        // )
        // if (duplicateTexts.length > 0) {
        //     log.debug("Duplicate texts found")
        //     score += 7
        // }

        // Check for excessive hashtag spam
        const hashtagPattern = /#\w+/g
        const excessiveHashtags = timeline.filter(tweet => {
            const hashtags = tweet.text.match(hashtagPattern)
            return hashtags && hashtags.length > 5
        })

        if (excessiveHashtags.length > timeline.length * 0.3) {
            log.debug("Excessive hashtags found")
            score += 7
        }

        return score
    }

    private checkAccountAgeActivity(): number {
        const user = this.timelineData.user
        const createdAt = new Date(user.created_at)
        const now = new Date()
        const accountAgeMonths =
            (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24 * 30)

        let score = 0

        // New account with high activity
        if (accountAgeMonths < 3 && user.statuses_count > 1000) {
            score += 4
        }

        // Few tweets but many followers (or vice versa)
        if (user.statuses_count < 50 && user.sub_count > 1000) {
            score += 4
        }

        return score
    }

    // private checkEngagementAnomalies(): number {
    //     const timeline = this.timelineData.timeline
    //     let score = 0

    //     // Check for unnatural like/retweet ratios
    //     const engagementData = timeline.map(tweet => ({
    //         likes: tweet.favorites,
    //         retweets: tweet.retweets,
    //         replies: tweet.replies,
    //     }))

    //     if (engagementData.length > 5) {
    //         const avgLikes =
    //             engagementData.reduce((sum, data) => sum + data.likes, 0) /
    //             engagementData.length
    //         const avgRetweets =
    //             engagementData.reduce((sum, data) => sum + data.retweets, 0) /
    //             engagementData.length

    //         // Suspicious if retweets consistently higher than likes
    //         if (avgRetweets > avgLikes * 2) {
    //             score += 6
    //         }

    //         // Check for very consistent engagement patterns
    //         const likeVariance =
    //             engagementData.reduce(
    //                 (sum, data) => sum + Math.pow(data.likes - avgLikes, 2),
    //                 0,
    //             ) / engagementData.length
    //         if (likeVariance < avgLikes * 0.1 && avgLikes > 0) {
    //             score += 6
    //         }
    //     }

    //     return score
    // }

    private checkQuotaLimitMessages(): number {
        const quotaPatterns = [
            /exceeded.*quota/i,
            /quota.*limit.*reached/i,
            /check.*plan.*billing/i,
            /api.*limit.*exceeded/i,
            /too many requests/i,
            /billing.*details/i,
            /current.*quota.*exceeded/i,
            /rate.*limit.*exceeded/i,
        ]

        for (const tweet of this.timelineData.timeline) {
            const text = tweet.text.toLowerCase()
            if (quotaPatterns.some(pattern => pattern.test(text))) {
                return 1000 // Definitive bot
            }
        }
        return 0
    }
}

export class Twitter {
    private static instance: Twitter

    demos_twitter_username = "demos_network"
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
    async makeRequest<T>(url: string, delay = 0): Promise<AxiosResponse<T>> {
        if (delay > 0) {
            await new Promise(resolve => setTimeout(resolve, delay))
            log.debug(`☺️😔👀 Delayed request to ${url} for ${delay}ms`)
        }

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

    async getTimeline(
        username: string,
        userId: string,
    ): Promise<TwitterTimelineResponse> {
        const res = await this.makeRequest<TwitterTimelineResponse>(
            `${this.api_url}/timeline.php?screenname=${username}&rest_id=${userId}`,
        )

        if (res.status === 200) {
            await fs.promises.writeFile(
                `data/twitter/${userId}.json`,
                JSON.stringify(res.data),
            )
            return res.data
        } else {
            throw new Error("Failed to get timeline")
        }
    }

    async getFollowers(
        username: string,
        userId: string,
    ): Promise<TwitterFollowersResponse> {
        const res = await this.makeRequest<TwitterFollowersResponse>(
            `${this.api_url}/followers.php?screenname=${username}`,
        )

        if (res.status === 200) {
            await fs.promises.writeFile(
                `data/twitter/${userId}_followers.json`,
                JSON.stringify(res.data),
            )
            return res.data
        } else {
            throw new Error("Failed to get followers")
        }
    }

    async checkIsBot(username: string, userId: string): Promise<boolean> {
        try {
            const timelineData = await this.getTimeline(username, userId)
            const followersData = await this.getFollowers(username, userId)

            const detector = new TwitterBotDetector(
                timelineData,
                followersData,
                username,
            )
            const result = detector.detectBot()
            log.debug(
                `User ${username} ${result ? "IS a bot" : "IS NOT a bot"}`,
            )
            return result
        } catch (error) {
            console.error("Error checking if user is bot:", error)
            return undefined
        }
    }

    static getInstance() {
        if (!Twitter.instance) {
            Twitter.instance = new Twitter()

            // create the directory if it doesn't exist
            if (!fs.existsSync("data/twitter")) {
                fs.mkdirSync("data/twitter", { recursive: true })
            }
        }

        return Twitter.instance
    }
}
