import Chain from "src/libs/blockchain/chain"
import * as fs from "fs"

// NOTE Sleep function
async function sleep(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms)
    })
}

export default async function findGenesisBlock() {
    let genesis_block = await Chain.getGenesisBlock()
    //await sleep(1000)
    console.log(genesis_block)
    if (genesis_block.length == 0) {
        // We need to initialize the genesis block
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
        let genesis_hash = Chain.generateGenesisBlock(genesis_json)
        console.log("Genesis block created: " + genesis_hash + "\n")
    } else console.log("Genesis block found: ")
    console.log(genesis_block)
    console.log(genesis_block[0].hash)
}
