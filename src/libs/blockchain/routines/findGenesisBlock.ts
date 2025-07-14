/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { Twitter } from "@/libs/identity/tools/twitter"
import Datasource from "@/model/datasource"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import log from "@/utilities/logger"
import { Web2GCRData } from "@kynesyslabs/demosdk/types"
import * as fs from "fs"
import Chain from "src/libs/blockchain/chain"

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

export default async function findGenesisBlock() {
    await awardDemosFollowPoints()

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
