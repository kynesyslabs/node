/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import * as fs from "fs"
import Chain from "src/libs/blockchain/chain"

function getLatestGCRRecoveryData() {
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
        console.error("Error getting latest GCR recovery data:", error)
        return null
    }
}

export default async function findGenesisBlock() {
    console.log("[GENESIS] Looking for the genesis block...")
    const genesisBlockQuery = await Chain.getGenesisBlock()
    console.log("[GENESIS] Received genesis search query")
    //console.log(genesis_block_q)
    let genesisBlock
    if (!genesisBlockQuery) {
        console.log("[GENESIS] No genesis block found.")
        genesisBlock = null
    } else {
        genesisBlock = genesisBlockQuery
    }
    // console.log(genesis_block)
    // throw new Error("genesis block found")
    if (!genesisBlock) {
        console.log("[BOOTSTRAP] Initializing the genesis block\n")
        if (!fs.existsSync("data/genesis.json")) {
            // Exit if there are no genesis block
            console.log("No genesis block found, exiting")
            // eslint-disable-next-line no-undef
            process.exit(-5)
        }
        console.log("[BOOTSTRAP] Loading the genesis block\n")
        // Loading the genesis block
        const genesisData = JSON.parse(
            fs.readFileSync("data/genesis.json", "utf8"),
        )

        const finalBalances = {}

        for (const balance of genesisData["balances"]) {
            finalBalances[balance[0]] = balance[1]
        }

        const recovereryGenesis = getLatestGCRRecoveryData()

        if (recovereryGenesis) {
            genesisData["users"] = recovereryGenesis["users"]

            // add recovereryGenesis["genesis_balances"] to genesisData["balances"]
            // (replace the ones that are already in genesisData["balances"])
            for (const balance of recovereryGenesis["genesis_balances"]) {
                finalBalances[balance[0]] = balance[1]
            }
        }

        genesisData["balances"] = Object.entries(finalBalances)
        console.log("[BOOTSTRAP] Loaded the genesis block\n")

        // Adding the genesis block to the chain
        console.log("[BOOTSTRAP] Adding the genesis block to the chain\n")
        const genesisHash = await Chain.generateGenesisBlock(genesisData)
        console.log("[BOOTSTRAP] Genesis block created: " + genesisHash + "\n")
        genesisBlock = await Chain.getGenesisBlock()
    } else {
        console.log("Genesis block found: ")
    }
    console.log(genesisBlock)
    console.log(genesisBlock.hash)
}
