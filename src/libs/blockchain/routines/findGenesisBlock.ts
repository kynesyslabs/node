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
import { ForkConfigValidationError, loadForkConfigFromGenesis } from "@/forks"

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

    // REVIEW: P2 — load fork config from data/genesis.json (when present)
    // BEFORE the genesis-already-present early return, so a node that has
    // already initialized its chain still picks up its fork activation
    // heights at every boot. Absent `forks` field leaves
    // SharedState.forkConfig at its inactive default, matching pre-P2
    // behavior bit-for-bit.
    if (fs.existsSync("data/genesis.json")) {
        try {
            let cfgGenesisData = JSON.parse(
                fs.readFileSync("data/genesis.json", "utf8"),
            )
            if (typeof cfgGenesisData === "string") {
                cfgGenesisData = JSON.parse(cfgGenesisData)
            }
            loadForkConfigFromGenesis(cfgGenesisData)
        } catch (e) {
            // GH#3214986124 (Greptile P1) and follow-up: fail-closed on
            // ANY failure to read the fork config. A malformed
            // activationHeight, a JSON parse error, or an IO read error
            // are all operator misconfigurations of consensus-relevant
            // state. The original fs.existsSync above already
            // short-circuits the legitimate "no genesis configured"
            // path; everything inside this try block is a real read or
            // validation failure. Silent fallback would let a typo or
            // truncated file silently disable the fork on this validator
            // while peers cross the activation height — same consensus
            // split the validation throw was meant to prevent.
            if (e instanceof ForkConfigValidationError) {
                log.error(
                    `[FORKS] Refusing to boot — invalid fork config in data/genesis.json: ${e.message}`,
                )
                throw e
            }
            log.error(
                `[FORKS] Refusing to boot — failed to read fork config from data/genesis.json: ${
                    e instanceof Error ? e.message : String(e)
                }`,
            )
            throw e
        }
    }

    log.info("[GENESIS] Looking for the genesis block...")
    const genesisBlockHash = await Chain.getGenesisBlockHash()
    if (genesisBlockHash) {
        log.info(`[GENESIS] Genesis block found. Hash: ${genesisBlockHash}`)
        return
    }

    if (!fs.existsSync("data/genesis.json")) {
        log.error("[GENESIS] No genesis block found, exiting")
        // Audit-sweep batch E: was `process.exit(1)`. Throw so
        // `main().catch → gracefulShutdown` handles uniformly.
        throw new Error(
            "[GENESIS] data/genesis.json missing — refusing to boot",
        )
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
