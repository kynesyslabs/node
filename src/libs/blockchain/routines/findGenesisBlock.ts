/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import * as fs from "fs"
import Chain from "src/libs/blockchain/chain"

export default async function findGenesisBlock() {
    console.log("[GENESIS] Looking for the genesis block...")
    let genesis_block_q = await Chain.getGenesisBlock()
    console.log("[GENESIS] Received genesis search query")
    //console.log(genesis_block_q)
    let genesis_block
    if (!genesis_block_q) {
        console.log("[GENESIS] No genesis block found.")
        genesis_block = null
    } else {
        genesis_block = genesis_block_q
    }
    // console.log(genesis_block)
    // throw new Error("genesis block found")
    if (!genesis_block) {
        console.log("[BOOTSTRAP] Initializing the genesis block\n")
        if (!fs.existsSync("data/genesis.json")) {
            // Exit if there are no genesis block
            console.log("No genesis block found, exiting")
            // eslint-disable-next-line no-undef
            process.exit(-5)
        }
        console.log("[BOOTSTRAP] Loading the genesis block\n")
        // Loading the genesis block
        let genesis_data = JSON.parse(
            fs.readFileSync("data/genesis.json", "utf8"),
        )
        console.log("[BOOTSTRAP] Loaded the genesis block\n")
        // console.log("imported genesis json data")
        // console.log(genesis_data)
        // throw new Error()
        // Adding the genesis block to the chain
        console.log("[BOOTSTRAP] Adding the genesis block to the chain\n")
        let genesis_hash = await Chain.generateGenesisBlock(genesis_data)
        console.log("[BOOTSTRAP] Genesis block created: " + genesis_hash + "\n")
        genesis_block = await Chain.getGenesisBlock()
    } else {
        console.log("Genesis block found: ")
    }
    console.log(genesis_block)
    console.log(genesis_block.hash)
}
