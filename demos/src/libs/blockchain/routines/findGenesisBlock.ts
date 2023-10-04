/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import Chain from "src/libs/blockchain/chain"
import * as fs from "fs"

export default async function findGenesisBlock() {
    let genesis_block = await Chain.getGenesisBlock()
    console.log(genesis_block)
    if (genesis_block.length == 0) {
        console.log("[BOOTSTRAP] Initializing the genesis block\n")
        if (!fs.existsSync("data/genesis.json")) {
            // Exit if there are no genesis block
            console.log("No genesis block found, exiting")
            // eslint-disable-next-line no-undef
            process.exit(-5)
        }
        // Loading the genesis block
        let genesis_json = JSON.parse(
            fs.readFileSync("data/genesis.json", "utf8"),
        )
        // Adding the genesis block to the chain
        let genesis_hash = await Chain.generateGenesisBlock(genesis_json)
        console.log("Genesis block created: " + genesis_hash + "\n")
        genesis_block = await Chain.getGenesisBlock()
    } else {
        console.log("Genesis block found: ")
    }
    console.log(genesis_block)
    console.log(genesis_block[0].hash)
}

// REVIEW Experimental incremental genesis
// TODO Too and replace the above 
export async function findGenesis() {
    let blocks: any[] = await Chain.getGenesisBlocks()
    if (blocks.length < 1) {
        console.log("[BOOTSTRAP] Initializing the genesis block\n")
        if (!fs.existsSync("data/genesis")) { // As a folder containing .json files
            // Exit if there are no genesis block
            console.log("No genesis files found, exiting")
            // eslint-disable-next-line no-undef
            process.exit(-5)
        }
        // Loading the genesis block
        let genesis_json = JSON.parse(
            fs.readFileSync("data/genesis/genesis.json", "utf8"), // TODO Read all json files recursively
        )
        // Adding the genesis block to the chain
        let genesis_hashes = await Chain.generateGenesisBlocks(genesis_json)
        console.log("Genesis blocks created: " + genesis_hashes + "\n")
        await Chain.getGenesisUniqueBlock()
        console.log("Derived artifact block")
    } else {
        console.log("Genesis block found ")
    }    
}