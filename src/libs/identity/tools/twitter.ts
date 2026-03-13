import * as fs from "fs"
import axios, { AxiosResponse } from "axios"
import {
    Tweet,
    TwitterTimelineResponse,
    TwitterFollowersResponse,
} from "@kynesyslabs/demosdk/types"
import log from "@/utilities/logger"
import { Config } from "src/config"
import {
    TWITTER_BOT_SCORE_THRESHOLD,
    TWITTER_VERIFICATION_SCORE,
    TWITTER_USERNAME_PATTERN_SCORE,
    TWITTER_NAME_PREFIX_LENGTH,
    TWITTER_USERNAME_TRAILING_DIGITS,
    TWITTER_BIO_KEYWORD_SCORE,
    TWITTER_SUSPICIOUS_BIO_KEYWORDS,
    TWITTER_DEFAULT_AVATAR_SCORE,
    TWITTER_FOLLOWER_RATIO_SCORE,
    TWITTER_FOLLOWER_RATIO_FRIENDS_MIN,
    TWITTER_FOLLOWER_RATIO_SUB_MAX,
    TWITTER_SUSPICIOUS_FOLLOWERS_FRACTION,
    TWITTER_SUSPICIOUS_FOLLOWERS_SCORE,
    TWITTER_TIMING_VARIANCE_RATIO,
    TWITTER_TIMING_REGULARITY_SCORE,
    TWITTER_ACTIVE_HOURS_THRESHOLD,
    TWITTER_ACTIVE_HOURS_SCORE,
    TWITTER_RETWEET_RATIO_THRESHOLD,
    TWITTER_RETWEET_SCORE,
    TWITTER_EXCESSIVE_HASHTAG_COUNT,
    TWITTER_EXCESSIVE_HASHTAG_RATIO,
    TWITTER_HASHTAG_SPAM_SCORE,
    TWITTER_NEW_ACCOUNT_MONTHS,
    TWITTER_NEW_ACCOUNT_HIGH_ACTIVITY,
    TWITTER_NEW_ACCOUNT_SCORE,
    TWITTER_FEW_TWEETS_THRESHOLD,
    TWITTER_MANY_FOLLOWERS_THRESHOLD,
    TWITTER_FEW_TWEETS_MANY_FOLLOWERS_SCORE,
    TWITTER_QUOTA_BOT_SCORE,
    TWITTER_MS_PER_MONTH,
} from "./constants"

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

        return userScore >= TWITTER_BOT_SCORE_THRESHOLD // Likely Bot threshold
    }

    private checkVerification(): number {
        return this.timelineData.user.blue_verified ? TWITTER_VERIFICATION_SCORE : 0
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
        if (suspiciousPercentage >= TWITTER_SUSPICIOUS_FOLLOWERS_FRACTION) {
            return TWITTER_SUSPICIOUS_FOLLOWERS_SCORE
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

            // Get first N characters of each name (case sensitive)
            if (firstName.length >= TWITTER_NAME_PREFIX_LENGTH && lastName.length >= TWITTER_NAME_PREFIX_LENGTH) {
                const firstThree = firstName.substring(0, TWITTER_NAME_PREFIX_LENGTH)
                const lastThree = lastName.substring(0, TWITTER_NAME_PREFIX_LENGTH)

                // Check if both character prefixes are in username (case sensitive)
                if (
                    cleanUsername.includes(firstThree) &&
                    cleanUsername.includes(lastThree)
                ) {
                    score = TWITTER_USERNAME_PATTERN_SCORE
                }
            }
        }

        // Check if username ends with trailing digits
        if (cleanUsername.match(new RegExp(`[0-9]{${TWITTER_USERNAME_TRAILING_DIGITS}}$`))) {
            score = TWITTER_USERNAME_PATTERN_SCORE
        }

        return score
    }

    private checkBioContentGeneric(bio: string): number {
        if (!bio) return 0

        const normalizedBio = bio.toLowerCase()
        let score = 0

        // Check for suspicious keywords
        for (const keyword of TWITTER_SUSPICIOUS_BIO_KEYWORDS) {
            if (normalizedBio.includes(keyword)) {
                score += TWITTER_BIO_KEYWORD_SCORE
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
            score += TWITTER_DEFAULT_AVATAR_SCORE
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
        if (profile.friends > TWITTER_FOLLOWER_RATIO_FRIENDS_MIN && profile.sub_count < TWITTER_FOLLOWER_RATIO_SUB_MAX) {
            score = TWITTER_FOLLOWER_RATIO_SCORE
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
            if (variance < avgInterval * TWITTER_TIMING_VARIANCE_RATIO) {
                score += TWITTER_TIMING_REGULARITY_SCORE
            }
        }

        // Check for 24/7 activity (tweets across all hours)
        const hours = timeline.map(tweet =>
            new Date(tweet.created_at).getHours(),
        )
        const uniqueHours = new Set(hours)
        if (uniqueHours.size > TWITTER_ACTIVE_HOURS_THRESHOLD) {
            // Active in more than threshold hours
            score += TWITTER_ACTIVE_HOURS_SCORE
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
        if (retweetCount > timeline.length * TWITTER_RETWEET_RATIO_THRESHOLD) {
            log.debug("Retweet count is too high")
            score += TWITTER_RETWEET_SCORE
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
            return hashtags && hashtags.length > TWITTER_EXCESSIVE_HASHTAG_COUNT
        })

        if (excessiveHashtags.length > timeline.length * TWITTER_EXCESSIVE_HASHTAG_RATIO) {
            log.debug("Excessive hashtags found")
            score += TWITTER_HASHTAG_SPAM_SCORE
        }

        return score
    }

    private checkAccountAgeActivity(): number {
        const user = this.timelineData.user
        const createdAt = new Date(user.created_at)
        const now = new Date()
        const accountAgeMonths =
            (now.getTime() - createdAt.getTime()) / TWITTER_MS_PER_MONTH

        let score = 0

        // New account with high activity
        if (accountAgeMonths < TWITTER_NEW_ACCOUNT_MONTHS && user.statuses_count > TWITTER_NEW_ACCOUNT_HIGH_ACTIVITY) {
            score += TWITTER_NEW_ACCOUNT_SCORE
        }

        // Few tweets but many followers (or vice versa)
        if (user.statuses_count < TWITTER_FEW_TWEETS_THRESHOLD && user.sub_count > TWITTER_MANY_FOLLOWERS_THRESHOLD) {
            score += TWITTER_FEW_TWEETS_MANY_FOLLOWERS_SCORE
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
                return TWITTER_QUOTA_BOT_SCORE // Definitive bot
            }
        }
        return 0
    }
}

export class Twitter {
    private static instance: Twitter

    demos_twitter_username = "demos_network"
    api_key = Config.getInstance().identity.rapidApiKey
    api_host = Config.getInstance().identity.rapidApiHost
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
            log.error(
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
            log.error("Error checking if user is bot:", error)
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
