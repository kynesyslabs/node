/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import * as fs from "fs"
import log from "@/utilities/logger"
import Chain from "src/libs/blockchain/chain"
import { BeforeFindGenesisHooks } from "./beforeFindGenesisHooks"
import { Config } from "src/config"

function getLatestGCRRecoveryData() {
    if (!Config.getInstance().core.restore) {
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

export default async function findGenesisBlock() {
    // INFO: Maintenance hooks here!
    // await new BeforeFindGenesisHooks().awardDemosFollowPoints()

    log.info("[GENESIS] Looking for the genesis block...")
    const genesisBlockHash = await Chain.getGenesisBlockHash()
    if (genesisBlockHash) {
        log.info(`[GENESIS] Genesis block found. Hash: ${genesisBlockHash}`)
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
