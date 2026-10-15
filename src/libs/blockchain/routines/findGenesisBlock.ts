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
import { getSharedState } from "@/utilities/sharedState"
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

function readGenesisFile() {
    let genesisData = JSON.parse(fs.readFileSync("data/genesis.json", "utf8"))
    if (typeof genesisData === "string") {
        genesisData = JSON.parse(genesisData)
    }
    return genesisData
}

/**
 * Fail closed on ANY failure to read the fork config (GH#3214986124, Greptile
 * P1, and follow-up): a malformed activationHeight, a JSON parse error or an IO
 * read error are all operator misconfigurations of consensus-relevant state.
 * The caller only gets here when the file exists, so everything inside is a
 * real read or validation failure. A silent fallback would let a typo or a
 * truncated file disable the fork on this validator while peers cross the
 * activation height, the same consensus split the validation throw prevents.
 */
function loadForkConfigFromGenesisFile() {
    try {
        loadForkConfigFromGenesis(readGenesisFile())
    } catch (e) {
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

/** Overlay a recovery export's users and genesis balances onto the genesis data. */
function applyRecoveryData(genesisData, recoveryGenesis) {
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

export default async function findGenesisBlock() {
    // INFO: Maintenance hooks here!
    // await new BeforeFindGenesisHooks().awardDemosFollowPoints()

    // REVIEW: P2 — load fork config from data/genesis.json (when present)
    // BEFORE the genesis-already-present early return, so a node that has
    // already initialized its chain still picks up its fork activation
    // heights at every boot. Absent `forks` field leaves
    // SharedState.forkConfig at its inactive default, matching pre-P2
    // behavior bit-for-bit.
    const hasGenesisFile = fs.existsSync("data/genesis.json")
    if (hasGenesisFile) {
        loadForkConfigFromGenesisFile()
    } else {
        // With no genesis file there is nothing to load: the defaults are this
        // node's schedule, and it can report them.
        getSharedState.forkConfigLoaded = true
    }

    log.info("[GENESIS] Looking for the genesis block...")
    const genesisBlockHash = await Chain.getGenesisBlockHash()
    if (genesisBlockHash) {
        log.info(`[GENESIS] Genesis block found. Hash: ${genesisBlockHash}`)
        return
    }

    if (!hasGenesisFile) {
        log.error("[GENESIS] No genesis block found, aborting boot")
        // Audit-sweep batch E: was `process.exit(1)`. Throw so
        // `main().catch → gracefulShutdown` handles uniformly.
        throw new Error(
            "[GENESIS] data/genesis.json missing — refusing to boot",
        )
    }

    // Loading the genesis block
    const genesisData = readGenesisFile()

    const recoveryGenesis = getLatestGCRRecoveryData()
    if (recoveryGenesis) {
        applyRecoveryData(genesisData, recoveryGenesis)
    }

    // Adding the genesis block to the chain
    return await Chain.generateGenesisBlock(genesisData)
}
