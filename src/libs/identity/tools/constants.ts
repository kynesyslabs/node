/**
 * Shared constants for identity tool modules.
 *
 * All magic numbers, thresholds, and hardcoded strings that were previously
 * inlined in tool files are collected here so they can be tuned in one place.
 */

// ---------------------------------------------------------------------------
// Twitter – Bot Detection Thresholds & Scores
// ---------------------------------------------------------------------------

/** Overall score at or above which an account is classified as a bot. */
export const TWITTER_BOT_SCORE_THRESHOLD = 15

/** Score adjustment when the user is Twitter Blue-verified. */
export const TWITTER_VERIFICATION_SCORE = -8

/** Score for username patterns that match suspicious heuristics. */
export const TWITTER_USERNAME_PATTERN_SCORE = 6

/** Minimum character prefix length used in name-in-username check. */
export const TWITTER_NAME_PREFIX_LENGTH = 3

/** Regex trailing-digit count that flags a username as suspicious. */
export const TWITTER_USERNAME_TRAILING_DIGITS = 5

/** Score added when the bio contains a suspicious keyword. */
export const TWITTER_BIO_KEYWORD_SCORE = 5

/** Keywords in a Twitter bio that indicate a suspicious account. */
export const TWITTER_SUSPICIOUS_BIO_KEYWORDS = ["nexyai.io", "$fan", "maxi"]

/** Score for a missing / default avatar. */
export const TWITTER_DEFAULT_AVATAR_SCORE = 4

/** Score for a skewed follower/following ratio. */
export const TWITTER_FOLLOWER_RATIO_SCORE = 4

/** Minimum "following" count that triggers follower-ratio check. */
export const TWITTER_FOLLOWER_RATIO_FRIENDS_MIN = 1000

/** Maximum "followers" count that triggers follower-ratio check. */
export const TWITTER_FOLLOWER_RATIO_SUB_MAX = 100

/** Fraction of suspicious followers that triggers a high score. */
export const TWITTER_SUSPICIOUS_FOLLOWERS_FRACTION = 0.6

/** Score added when the suspicious-followers fraction is exceeded. */
export const TWITTER_SUSPICIOUS_FOLLOWERS_SCORE = 10

/** Variance-to-mean ratio below which tweet timing is "too regular". */
export const TWITTER_TIMING_VARIANCE_RATIO = 0.1

/** Score for suspiciously regular posting intervals. */
export const TWITTER_TIMING_REGULARITY_SCORE = 5

/** Number of distinct posting hours that flags 24/7 activity. */
export const TWITTER_ACTIVE_HOURS_THRESHOLD = 20

/** Score for 24/7 posting activity. */
export const TWITTER_ACTIVE_HOURS_SCORE = 5

/** Fraction of timeline that is retweets before flagging. */
export const TWITTER_RETWEET_RATIO_THRESHOLD = 0.65

/** Score for excessive retweeting. */
export const TWITTER_RETWEET_SCORE = 7

/** Number of hashtags in a single tweet considered excessive. */
export const TWITTER_EXCESSIVE_HASHTAG_COUNT = 5

/** Fraction of timeline with excessive hashtags before flagging. */
export const TWITTER_EXCESSIVE_HASHTAG_RATIO = 0.3

/** Score for hashtag spam. */
export const TWITTER_HASHTAG_SPAM_SCORE = 7

/** Account age in months below which the account is considered "new". */
export const TWITTER_NEW_ACCOUNT_MONTHS = 3

/** Status count above which a new account is suspicious. */
export const TWITTER_NEW_ACCOUNT_HIGH_ACTIVITY = 1000

/** Score for a new account with high activity. */
export const TWITTER_NEW_ACCOUNT_SCORE = 4

/** Threshold: few tweets. */
export const TWITTER_FEW_TWEETS_THRESHOLD = 50

/** Threshold: many followers for few-tweet accounts. */
export const TWITTER_MANY_FOLLOWERS_THRESHOLD = 1000

/** Score for few tweets but many followers. */
export const TWITTER_FEW_TWEETS_MANY_FOLLOWERS_SCORE = 4

/** Score that definitively marks an account as a bot (quota-limit messages). */
export const TWITTER_QUOTA_BOT_SCORE = 1000

/** Milliseconds in one month (approximate, used for account-age calculation). */
export const TWITTER_MS_PER_MONTH = 1000 * 60 * 60 * 24 * 30

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------

/** Default request timeout for the Discord API client (ms). */
export const DISCORD_API_TIMEOUT_MS = 10_000

// ---------------------------------------------------------------------------
// Nomis
// ---------------------------------------------------------------------------

/** Chain IDs scored by default in the cross-chain Nomis request. */
export const NOMIS_SCORED_CHAINS = [1, 10, 56, 137, 5000, 8453, 42161, 59144]

/** Default HTTP timeout for Nomis wallet-score requests (ms). */
export const NOMIS_WALLET_SCORE_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------
// Human Passport
// ---------------------------------------------------------------------------

/** Cache time-to-live for Human Passport scores (ms). 1 hour. */
export const HUMAN_PASSPORT_CACHE_TTL_MS = 60 * 60 * 1000

/** Default HTTP timeout for Human Passport API requests (ms). */
export const HUMAN_PASSPORT_API_TIMEOUT_MS = 30_000

/** Default threshold for the "isHuman" convenience method. */
export const HUMAN_PASSPORT_DEFAULT_HUMAN_THRESHOLD = 20

/** Default score used when parsing fails. */
export const HUMAN_PASSPORT_DEFAULT_SCORE = 0

/** Default threshold used when parsing fails. */
export const HUMAN_PASSPORT_DEFAULT_THRESHOLD = 20

// ---------------------------------------------------------------------------
// Ethos
// ---------------------------------------------------------------------------

/** Base URL for the Ethos Network public API. */
export const ETHOS_API_BASE_URL = "https://api.ethos.network/api/v2"

/** Default HTTP timeout for Ethos API requests (ms). */
export const ETHOS_API_TIMEOUT_MS = 10_000

// ---------------------------------------------------------------------------
// CrossChain
// ---------------------------------------------------------------------------

/** Etherscan v2 API base URL. */
export const ETHERSCAN_BASE_URL = "https://api.etherscan.io/v2/api"

/** Helius API base URL. */
export const HELIUS_BASE_URL = "https://api.helius.xyz/v0"

/** Default end-block sentinel for Etherscan pagination. */
export const ETHERSCAN_DEFAULT_END_BLOCK = 99999999
