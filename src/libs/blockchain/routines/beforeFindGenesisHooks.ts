import * as fs from "fs"
import { In, LessThan, Not } from "typeorm"
import log from "@/utilities/logger"
import Datasource from "@/model/datasource"

import { Twitter } from "@/libs/identity/tools/twitter"
import { Web2GCRData } from "@kynesyslabs/demosdk/types"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { CrossChainTools } from "@/libs/identity/tools/crosschain"
import { SavedXmIdentity } from "@/model/entities/types/IdentityTypes"

/**
 * This class contains various hooks used for maintenance
 */
export class BeforeFindGenesisHooks {
    /**
     * Award demos follow points to all users who have a twitter identity
     * but don't have the demosFollow property
     */
    async awardDemosFollowPoints() {
        // return
        const db = await Datasource.getInstance()
        const gcrMainRepository = db.getDataSource().getRepository(GCRMain)

        const seenAccounts = new Set<string>()

        // Use JSONB query to fetch accounts that have Twitter identities
        const accountsWithTwitter = await gcrMainRepository
            .createQueryBuilder("gcr")
            .where("gcr.identities->'web2'->'twitter' IS NOT NULL")
            .andWhere({
                flaggedReason: Not(
                    In(["manualFlag", "referrerFlagged", "twitter_bot"]),
                ),
            })
            .getMany()

        log.only(
            `[DEMOS FOLLOW] Found ${accountsWithTwitter.length} accounts with Twitter identities`,
        )

        log.only(
            `[DEMOS FOLLOW] ${accountsWithTwitter.length} accounts need processing`,
        )

        // Process accounts in batches
        const batchSize = 10
        for (let i = 0; i < accountsWithTwitter.length; i += batchSize) {
            const batch = accountsWithTwitter.slice(i, i + batchSize)
            log.only(
                `[DEMOS FOLLOW] Processing batch ${
                    Math.floor(i / batchSize) + 1
                }/${Math.ceil(accountsWithTwitter.length / batchSize)} (${
                    batch.length
                } accounts)`,
            )

            // Process all accounts in the current batch concurrently
            await Promise.all(
                batch.map(account =>
                    this.awardDemosFollowPointsToSingleAccount(
                        account,
                        gcrMainRepository,
                        seenAccounts,
                    ),
                ),
            )
        }

        // Audit-sweep batch E: was `process.exit(0)`. The sole
        // caller (`findGenesisBlock.ts:43`) is currently commented
        // out, so this exit is a time-bomb — uncommenting the
        // caller would have killed the node mid-boot the moment
        // the maintenance hook finished its first run. Returning
        // cleanly so the caller can resume the normal boot
        // sequence after the one-shot point-award sweep completes.
        return
    }

    /**
     * Award demos follow points to a single account if they follow demos on Twitter
     */
    async awardDemosFollowPointsToSingleAccount(
        account: GCRMain,
        gcrMainRepository: any,
        seenAccounts: Set<string>,
    ): Promise<void> {
        try {
            // if account has demosFollow points, return
            if (account.points.breakdown.demosFollow) {
                log.only(
                    `[DEMOS FOLLOW] User ${account.pubkey} already has demos follow points`,
                )
                return
            }

            // Get the first Twitter identity for this account
            const twitterIdentities = account.identities.web2["twitter"]
            if (
                !twitterIdentities ||
                !Array.isArray(twitterIdentities) ||
                twitterIdentities.length === 0
            ) {
                return
            }

            const twitterIdentity = twitterIdentities[0] as Web2GCRData["data"]
            if (!twitterIdentity.username || !twitterIdentity.userId) {
                return
            }

            // Skip if we've already processed this Twitter user
            if (seenAccounts.has(twitterIdentity.userId)) {
                return
            }
            seenAccounts.add(twitterIdentity.userId)

            const twitter = Twitter.getInstance()

            // Check if the user follows demos
            const isFollowingDemos = await twitter.checkFollow(
                twitterIdentity.username,
            )

            log.only(
                `[DEMOS FOLLOW] User ${twitterIdentity.username} ${
                    isFollowingDemos ? "follows" : "does not follow"
                } demos`,
            )

            if (!isFollowingDemos) {
                return
            }

            // Award the demos follow point
            account.points.breakdown.demosFollow = 1
            account.points.totalPoints = (account.points.totalPoints || 0) + 1
            account.points.lastUpdated = new Date()

            await gcrMainRepository.save(account)

            log.only(
                `[DEMOS FOLLOW] Awarded point to user ${account.pubkey} (Twitter: @${twitterIdentity.username})`,
            )
        } catch (error) {
            log.error(
                `[DEMOS FOLLOW] Error processing account ${account.pubkey}: ${error}`,
            )
            // Add a small delay on error to prevent rate limiting issues
            await new Promise(resolve => setTimeout(resolve, 1000))
        }
    }

    /**
     * Review a single account and flag if it's a bot or has no EVM/Solana transactions
     */
    async reviewSingleAccount(
        account: GCRMain,
        gcrMainRepository: any,
    ): Promise<void> {
        try {
            log.only("Reviewing account: " + account.pubkey)
            // if (account.flagged || account.reviewed) {
            //     return
            // }
            log.only("reviewing account: " + account.pubkey)

            // INFO: Review Twitter identity
            // const twitterIdentities = account.identities.web2["twitter"]

            // if (twitterIdentities && twitterIdentities.length > 0) {
            //     const twitterIdentity = twitterIdentities[0] as Web2GCRData["data"]
            //     if (twitterIdentity.username) {
            //         log.only(
            //             "Checking Twitter identity: " + twitterIdentity.username,
            //         )
            //         const isBot = await Twitter.getInstance().checkIsBot(
            //             twitterIdentity.username,
            //             twitterIdentity.userId,
            //         )

            //         if (isBot) {
            //             log.only("Flagged account: " + account.pubkey)
            //             log.only("Twitter identity: " + twitterIdentity.username)
            //             account.flagged = true
            //             account.flaggedReason = "twitter_bot"
            //             account.reviewed = true
            //             await gcrMainRepository.save(account)
            //             return
            //         }
            //     }
            // } else {
            //     // log.only("Flagged account: " + account.pubkey)
            //     // log.only("No Twitter identity")
            //     // account.flagged = true
            //     // account.reviewed = true
            //     // await gcrMainRepository.save(account)
            //     await GCR.removeAccount(account.pubkey)
            //     return
            // }

            // Track transaction counts for both chains
            // let evmHasTransactions = false
            // let solanaHasTransactions = false
            // let hasEvmIdentity = false
            // let hasSolanaIdentity = false

            // // INFO: Review EVM identity
            // const evmIdentities = account.identities.xm["evm"] || {}
            // const ethIdentity = evmIdentities["mainnet"] || []

            // if (ethIdentity && ethIdentity.length > 0) {
            //     hasEvmIdentity = true
            //     const id1 = ethIdentity[0] as SavedXmIdentity
            //     log.only("Checking EVM identity: " + id1.address)

            //     const txcount = await CrossChainTools.countEthTransactionsByAddress(
            //         id1.address,
            //         1,
            //     )

            //     if (txcount > 0) {
            //         evmHasTransactions = true
            //         log.only("EVM identity: " + id1.address)
            //         log.only("Txcount: " + txcount)
            //     }
            // }

            // INFO: Review Solana identity
            const solanaIdentities = account.identities.xm["solana"] || {}
            const solanaIdentity = solanaIdentities["mainnet"] || []

            if (solanaIdentity && solanaIdentity.length > 0) {
                const id1 = solanaIdentity[0] as SavedXmIdentity
                log.only("Checking Solana identity: " + id1.address)

                const txcount =
                    await CrossChainTools.countSolanaTransactionsByAddress(
                        id1.address,
                    )

                log.only("Solana identity: " + id1.address)
                log.only("Txcount: " + txcount)

                if (txcount === 0) {
                    account.flagged = true
                    account.flaggedReason = "web3_no_tx"
                    log.only(
                        "Flagged account: " +
                            account.pubkey +
                            " because it has no WEB3 activity",
                    )
                } else {
                    account.flagged = true
                    account.flaggedReason = "only_evm_no_tx"
                }
            } else {
                log.error(
                    "No Solana identity found for account: " + account.pubkey,
                )
            }

            account.reviewed = true
            await gcrMainRepository.save(account)
        } catch (error) {
            log.error(`Error reviewing account ${account.pubkey}: ${error}`)
            // handle axioserror 429 with sleep
            log.only("Sleeping for 5 second")
            await new Promise(resolve => setTimeout(resolve, 5000))
        }
    }

    /**
     * Review all account and flag them if they are bots or have no EVM/Solana transactions
     */
    async reviewAccounts() {
        if (!fs.existsSync("data/twitter")) {
            fs.mkdirSync("data/twitter", { recursive: true })
        }

        const db = await Datasource.getInstance()
        const gcrMainRepository = db.getDataSource().getRepository(GCRMain)

        // Re-review flagged evm_no_tx accounts
        const accounts = await gcrMainRepository.find({
            where: {
                balance: LessThan(BigInt(10000000000)),
                flagged: true,
                flaggedReason: "evm_no_tx",
            },
        })

        log.info("total flagged evm_no_tx accounts: " + accounts.length)

        // Process accounts in batches of N
        const batchSize = 1
        for (let i = 0; i < accounts.length; i += batchSize) {
            const batch = accounts.slice(i, i + batchSize)
            log.only(
                `Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(
                    accounts.length / batchSize,
                )} (${batch.length} accounts)`,
            )

            // Process all accounts in the current batch concurrently
            await Promise.all(
                batch.map(account =>
                    this.reviewSingleAccount(account, gcrMainRepository),
                ),
            )
        }
    }

    async removeInvalidAccounts() {
        const db = await Datasource.getInstance()
        const gcrMainRepository = db.getDataSource().getRepository(GCRMain)

        const accounts = await gcrMainRepository.find({
            where: {
                balance: LessThan(BigInt(10000000000)),
            },
        })

        const accountSet = new Set(accounts.map(account => account.pubkey))

        let removedAccounts = 0
        let globalDeductedPoints = 0

        for (const account of accounts) {
            // if referrer is not found, remove the account
            if (
                account.referralInfo.referredBy &&
                !accountSet.has(account.referralInfo.referredBy)
            ) {
                log.only(
                    "Removing account: " +
                        account.pubkey +
                        " because referrer is not found",
                )
                await gcrMainRepository.remove(account)
                removedAccounts++
                globalDeductedPoints += account.points.totalPoints
                continue
            }

            const referrals = account.referralInfo.referrals || []

            // normalize points
            if (referrals.length > 0) {
                let totalDeductedPoints = 0
                // find non-existing accounts and deduct points
                for (const referral of account.referralInfo.referrals) {
                    if (!accountSet.has(referral.referredUserId)) {
                        log.only(
                            "Deducting points for non-existing account: " +
                                referral.referredUserId,
                        )
                        log.only("referral: " + JSON.stringify(referral))

                        account.points.totalPoints -= referral.pointsAwarded
                        account.points.breakdown.referrals -=
                            referral.pointsAwarded
                        account.referralInfo.referrals =
                            account.referralInfo.referrals.filter(
                                r =>
                                    r.referredUserId !==
                                    referral.referredUserId,
                            )
                        totalDeductedPoints += referral.pointsAwarded
                    }
                }

                globalDeductedPoints += totalDeductedPoints
                log.only("total deducted points: " + totalDeductedPoints)
            }

            await gcrMainRepository.save(account)
        }

        log.only("Removed " + removedAccounts + " accounts")
        log.only("Global deducted points: " + globalDeductedPoints)
        return removedAccounts || globalDeductedPoints
    }
}
