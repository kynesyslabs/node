// INFO Support for the Tron network

import required from "src/utilities/required"
import defaultChainAsync from "./types/defaultChainAsync"
import TronWeb from "tronweb"

// LINK to the testnet https://api.shasta.trongrid.io

export default class TRON extends defaultChainAsync {
    // LINK https://github.com/tronprotocol/tronweb
    // NOTE As Tron supports solidity contracts, we need to study for it quite a lot
    // TODO See TVM and EVM

    constructor() {
        super("https://api.shasta.trongrid.io")
        this.name = "TRON"
    }

    // INFO Connecting to a provider
    async connect(rpc_url: string): Promise<boolean> {
        this.provider = new TronWeb({
            fullHost: rpc_url,
        })
        return true
    }

    async disconnect(): Promise<any> {
        throw new Error("Method not implemented.")
    }
    getBalance(address: string): Promise<string> {
        throw new Error("Method not implemented.")
    }
    pay(receiver: string, amount: string): Promise<any> {
        throw new Error("Method not implemented.")
    }
    info(): Promise<string> {
        throw new Error("Method not implemented.")
    }

    // INFO Adding a wallet to the Tron network provider
    connectWallet(privateKey: string, api_key?: string) {
        required(this.provider, "Provider is not initialized")
        this.wallet = new TronWeb({
            fullHost: "https://api.shasta.trongrid.io",
            privateKey: privateKey,
            headers: { "TRON-PRO-API-KEY": api_key },
        })
    }

    createWallet() {}

    signTransaction(raw_transaction: any): Promise<any> {
        throw new Error("Method not implemented.")
    }
    sendTransaction(signed_transaction: any) {
        throw new Error("Method not implemented.")
    }
}
