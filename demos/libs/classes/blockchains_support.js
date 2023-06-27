// INFO This file contains all the methods and variables used to interact with the various blockchains in chainteract.js

const ethers = require("ethers")

let chains = {
    evm: {
        connect: async (rpc, private_key = null) => {
            let provider = new ethers.providers.JsonRpcProvider(rpc)
            if (private_key) {
                provider = new ethers.providers.JsonRpcProvider(
                    rpc,
                    private_key,
                )
            }
            return provider
        },
    },
    btc: {},
    solana: {},
}

module.exports = chains
