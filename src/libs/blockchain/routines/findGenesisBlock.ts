/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import * as fs from "fs"
import { LessThan } from "typeorm"
import log from "@/utilities/logger"
import Datasource from "@/model/datasource"
import Chain from "src/libs/blockchain/chain"
import { Twitter } from "@/libs/identity/tools/twitter"
import { Web2GCRData } from "@kynesyslabs/demosdk/types"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { SavedXmIdentity } from "@/model/entities/types/IdentityTypes"
import { CrossChainTools } from "@/libs/identity/tools/crosschain"
import GCR from "../gcr/gcr"
import { AxiosError } from "axios"

function getLatestGCRRecoveryData() {
    if (!process.env.RESTORE) {
        return null
    }

    const path = "output/"

    // return the file with the latest timestamp
    try {
        const files = fs.readdirSync(path)
        const latestFile = files.sort((a, b) => {
            const timeA = fs.statSync(path + a).mtime.getTime()
            const timeB = fs.statSync(path + b).mtime.getTime()
            return timeB - timeA
        })[0]

        return JSON.parse(fs.readFileSync(path + latestFile, "utf8"))
    } catch (error) {
        return null
    }
}

/**
 * Award demos follow points to all users who have a twitter identity
 * but don't have the demosFollow property
 */
async function awardDemosFollowPoints() {
    return
    const twitter = Twitter.getInstance()
    const db = await Datasource.getInstance()
    const gcrMainRepository = db.getDataSource().getRepository(GCRMain)

    const seenAccounts = {}

    // Use JSONB query to fetch accounts that have Twitter identities
    const accountsWithTwitter = await gcrMainRepository
        .createQueryBuilder("gcr")
        .where("gcr.identities->'web2'->'twitter' IS NOT NULL")
        .getMany()

    log.only(
        `[DEMOS FOLLOW] Found ${accountsWithTwitter.length} accounts with Twitter identities`,
    )

    for (const account of accountsWithTwitter) {
        if (account.points.breakdown.demosFollow) {
            log.only(
                `[DEMOS FOLLOW] User ${account.pubkey} already has demos follow points`,
            )
            continue
        }

        try {
            // Get the first Twitter identity for this account
            const twitterIdentities = account.identities.web2["twitter"]
            if (
                !twitterIdentities ||
                !Array.isArray(twitterIdentities) ||
                twitterIdentities.length === 0
            ) {
                continue
            }

            const twitterIdentity = twitterIdentities[0] as Web2GCRData["data"]
            if (!twitterIdentity.username) {
                continue
            }

            if (seenAccounts[twitterIdentity.userId]) {
                continue
            }
            seenAccounts[twitterIdentity.userId] = true

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
                continue
            }

            // Award the demos follow point
            account.points.breakdown.demosFollow = 1
            account.points.totalPoints = (account.points.totalPoints || 0) + 1
            // account.points.lastUpdated = new Date()

            await gcrMainRepository.save(account)

            log.only(
                `[DEMOS FOLLOW] Awarded point to user ${account.pubkey} (Twitter: @${twitterIdentity.username})`,
            )
        } catch (error) {
            log.error(
                `[DEMOS FOLLOW] Error processing account ${account.pubkey}: ${error}`,
            )
        }
    }

    // process.exit(0)
}

/**
 * Review a single account and flag if it's a bot or has no EVM/Solana transactions
 */
async function reviewSingleAccount(
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
            log.error("No Solana identity found for account: " + account.pubkey)
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
async function reviewAccounts() {
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

    console.log("total flagged evm_no_tx accounts: " + accounts.length)

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
                reviewSingleAccount(account, gcrMainRepository),
            ),
        )
    }
}

async function removeInvalidAccounts() {
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
                    log.only("referral: " + JSON.stringify(referral, null, 2))

                    account.points.totalPoints -= referral.pointsAwarded
                    account.points.breakdown.referrals -= referral.pointsAwarded
                    account.referralInfo.referrals =
                        account.referralInfo.referrals.filter(
                            r => r.referredUserId !== referral.referredUserId,
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

export default async function findGenesisBlock() {
    // let removedWhatever = 1
    // // recursively remove invalid accounts
    // while (removedWhatever > 0) {
    //     removedWhatever = await removeInvalidAccounts()
    //     log.only("Removed " + removedWhatever + " accounts")
    // }
    // process.exit(0)

    // await reviewAccounts()
    // process.exit(0)
    // await awardDemosFollowPoints()

    log.info("[GENESIS] Looking for the genesis block...")
    const genesisBlock = await Chain.getGenesisBlock()

    if (genesisBlock && genesisBlock.hash) {
        log.info("[GENESIS] Genesis block found. Hash: " + genesisBlock.hash)
        return
    }

    if (!fs.existsSync("data/genesis.json")) {
        log.error("[GENESIS] No genesis block found, exiting")
        process.exit(1)
    }

    // Loading the genesis block
    let genesisData = JSON.parse(fs.readFileSync("data/genesis.json", "utf8"))

    if (typeof genesisData === "string") {
        genesisData = JSON.parse(genesisData)
    }

    const recoveryGenesis = getLatestGCRRecoveryData()

    if (recoveryGenesis) {
        const finalBalances = {}

        for (const entry of genesisData["balances"]) {
            const [address, balance] = entry
            finalBalances[address] = balance
        }

        genesisData["users"] = recoveryGenesis["users"]

        // add recoveryGenesis["genesis_balances"] to genesisData["balances"]
        // (replacing the ones that are already in genesisData["balances"])
        for (const entry of recoveryGenesis["genesis_balances"]) {
            const [address, balance] = entry
            finalBalances[address] = balance
        }

        genesisData["balances"] = Object.entries(finalBalances)
    }

    // Adding the genesis block to the chain
    return await Chain.generateGenesisBlock(genesisData)
}
