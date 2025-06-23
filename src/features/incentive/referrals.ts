import bs58 from "bs58"
import log from "@/utilities/logger"
import Hashing from "@/libs/crypto/hashing"
import Datasource from "@/model/datasource"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"

export class Referrals {
    static readonly REFERRER_BONUS = 3
    static readonly REFERRED_USER_BONUS = 3

    /**
     * Calculate optimal bytes needed for target length
     */
    private static calculateBytesForLength(targetLength: number): number {
        // Base58 encoding: ~1.37 bytes per character on average
        // Add buffer to ensure we have enough entropy
        const bytesMap = {
            8: 8, // ~56 bits
            10: 9, // ~63 bits
            12: 10, // ~70 bits
            16: 14, // ~98 bits
        }

        return bytesMap[targetLength as keyof typeof bytesMap] || 10
    }

    /**
     * Generate a 2-character checksum for validation
     */
    private static generateChecksum(publicKey: string): string {
        const cleanKey = publicKey.startsWith("0x")
            ? publicKey.slice(2)
            : publicKey
        const checksumHash = Hashing.sha256(cleanKey + "CHECKSUM")
        const checksumBytes = Buffer.from(checksumHash.slice(0, 4), "hex")
        const checksumB58 = bs58.encode(checksumBytes)
        return checksumB58.substring(0, 2)
    }

    /**
     * Generates a collision-resistant referral code from an ed25519 public key
     *
     * @param publicKey The 66-character hex ed25519 public key (0x...)
     * @param options Configuration options
     *
     * @returns Referral code with specified properties
     */
    static generateReferralCode(
        publicKey: string,
        options: {
            length?: 8 | 10 | 12 | 16 // Explicit length options
            includeChecksum?: boolean // Add checksum for validation
            prefix?: string // Optional prefix
        } = {},
    ): string {
        const { length = 12, includeChecksum = false, prefix = "" } = options

        // Remove 0x prefix if present
        const cleanKey = publicKey.startsWith("0x")
            ? publicKey.slice(2)
            : publicKey

        // Validate input
        if (cleanKey.length !== 64) {
            throw new Error(
                "Invalid ed25519 public key: must be 64 hex characters",
            )
        }

        // Hash the public key to get uniform distribution
        const hash = Hashing.sha256(cleanKey)

        // Calculate bytes needed based on desired length and encoding efficiency
        const bytesNeeded = this.calculateBytesForLength(length)
        const hashBytes = Buffer.from(hash.slice(0, bytesNeeded * 2), "hex")

        // Encode using Base58 for human-friendly format
        let code = bs58.encode(hashBytes)

        // Truncate to exact length (Base58 can vary by 1-2 chars)
        code = code.substring(0, length)

        // Add checksum if requested
        if (includeChecksum) {
            const checksum = this.generateChecksum(publicKey)
            code = code.substring(0, length - 2) + checksum
        }

        return prefix + code
    }

    /**
     * Find account by referral code
     */
    public static async findAccountByReferralCode(
        referralCode: string,
    ): Promise<GCRMain | null> {
        const db = await Datasource.getInstance()
        const gcrMainRepository = db.getDataSource().getRepository(GCRMain)

        const account = await gcrMainRepository
            .createQueryBuilder("gcr")
            .where("gcr.referralInfo ->> 'referralCode' = :referralCode", {
                referralCode,
            })
            .getOne()

        return account
    }

    /**
     * Check if user is already in referrer's referrals list
     */
    public static isAlreadyReferred(
        referrerAccount: GCRMain,
        newUserPubkey: string,
    ): boolean {
        if (!referrerAccount.referralInfo?.referrals) {
            return false
        }

        return referrerAccount.referralInfo.referrals.some(
            referral => referral.referredUserId === newUserPubkey,
        )
    }

    /**
     * Check if existing account is eligible for referral
     */
    public static isEligibleForReferral(account: GCRMain): boolean {
        // Check if user already has been referred
        if (account.referralInfo?.referredBy) {
            return false
        }

        if ((account.referralInfo?.referrals || []).length > 0) {
            return false
        }

        if (account.referralInfo?.totalReferrals > 0) {
            return false
        }

        // Check if user already has points (before this current award)
        const currentTotal = account.points?.totalPoints || 0
        if (currentTotal > 0) {
            return false
        }

        return true
    }

    /**
     * Process referral for new account
     */
    public static async processReferral(
        newAccount: GCRMain,
        referralCode: string,
        gcrMainRepository: any,
    ): Promise<void> {
        const referrerAccount = await Referrals.findAccountByReferralCode(
            referralCode,
        )

        if (!referrerAccount) {
            // Invalid referral code
            return
        }

        if (referrerAccount.pubkey === newAccount.pubkey) {
            // Referrer and new user are the same
            return
        }

        if (Referrals.isAlreadyReferred(referrerAccount, newAccount.pubkey)) {
            // User already referred by this referrer
            return
        }

        await this.awardReferralPoints(
            referrerAccount,
            newAccount,
            gcrMainRepository,
        )
    }

    /**
     * Award referral points to referrer and update referral info
     */
    private static async awardReferralPoints(
        referrerAccount: GCRMain,
        newUserAccount: GCRMain,
        gcrMainRepository: any,
    ): Promise<void> {
        if (!referrerAccount.points.breakdown.referrals) {
            log.only("No referrals found, setting to 0")
            referrerAccount.points.breakdown.referrals = 0
        }

        if (!newUserAccount.points.breakdown.referrals) {
            log.only("No referrals found, setting to 0")
            newUserAccount.points.breakdown.referrals = 0
        }

        const date = new Date()

        // Award points to referrer
        log.only("incrementing points")
        referrerAccount.points.totalPoints += this.REFERRER_BONUS
        referrerAccount.points.breakdown.referrals += this.REFERRER_BONUS
        referrerAccount.points.lastUpdated = date

        log.only("final points: " + JSON.stringify(referrerAccount.points))

        // Update referrer's referral info
        log.only("updating referral info")
        referrerAccount.referralInfo.totalReferrals += 1
        referrerAccount.referralInfo.referrals.push({
            referredUserId: newUserAccount.pubkey,
            referredAt: date.toISOString(),
            pointsAwarded: this.REFERRER_BONUS,
        })
        log.only(
            "final referral info: " +
                JSON.stringify(referrerAccount.referralInfo),
        )

        // Update new user's referral info
        log.only("updating new user's referral info")
        if (!newUserAccount.referralInfo) {
            log.only("new user has no referral info, creating it")
            newUserAccount.referralInfo = {
                totalReferrals: 0,
                referralCode: Referrals.generateReferralCode(
                    newUserAccount.pubkey,
                ),
                referrals: [],
            }
        }

        newUserAccount.referralInfo.referredBy = referrerAccount.pubkey
        newUserAccount.points.totalPoints += this.REFERRED_USER_BONUS
        newUserAccount.points.breakdown.referrals += this.REFERRED_USER_BONUS
        newUserAccount.points.lastUpdated = date

        log.only(
            "final new user referral info: " +
                JSON.stringify(newUserAccount.referralInfo),
        )

        log.only("saving referrer account")
        // Save referrer account
        await gcrMainRepository.save(referrerAccount)
    }
}
