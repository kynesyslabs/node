// INFO This module allows DEMOS to talk to different chains providing an unified API to interact with them

let chains = require("./multichain/blockchains_support.js")
let crosschain_execution = require("./multichain/crosschain_execution.js")

class Chainteract {
    constructor(chain, rpc_url, private_key = null) {
        if (!chains[chain]) {
            throw new Error(`Chain ${chain} not found`)
        }
        this.methods = chains[chain] // Assigning to the object just the right methods for this chain
        this.rpc_url = rpc_url
        this.provider = this.methods.connect(this.rpc_url, private_key)
        this.is_evm = this.methods.is_evm()
    }
    // INFO Get chain name
    async getChainName() {
        let _res = this.methods.getChainName()
        return _res
    }
    // INFO Balance of an address
    async getBalance(address) {
        let _res = this.methods.getBalance(address)
        return _res
    }
    // TODO Write methods
    // TODO EVM Specific methods
}

module.exports = Chainteract
