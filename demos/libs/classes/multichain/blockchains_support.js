// INFO This file contains all the methods and variables used to interact with the various blockchains in chainteract.js

const ethers = require("ethers") // TODO Force 5.7.2

let chains = {
    evm: {
        provider: null,
        connect: async (rpc, private_key = null) => {
            this.provider = new ethers.providers.JsonRpcProvider(rpc)
            if (private_key) {
                this.provider = new ethers.providers.JsonRpcProvider(
                    rpc,
                    private_key,
                )
            }
            return this.provider
        },
        getBalance: async address => {
            // REVIEW If ethers still supports the same method
            return await this.provider.getBalance(address)
        },
    },
    btc: {},
    solana: {},
}

module.exports = chains
