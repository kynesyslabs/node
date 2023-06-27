// INFO This module allows DEMOS to talk to different chains providing an unified API to interact with them

let chains = require("./blockchains_support.js")

class Chainteract {
    constructor(chain, rpc_url, private_key = null) {
        if (!chains[chain]) {
            throw new Error(`Chain ${chain} not found`)
        }
        this.methods = chains[chain] // Assigning to the object just the right methods for this chain
        this.rpc_url = rpc_url
        this.provider = this.methods.connect(this.rpc_url, private_key)
    }
    // TODO Set up connections
}

module.exports = Chainteract
