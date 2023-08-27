// INFO Support for the Tron network

import required from "src/utilities/required"
import DefaultChain from "./types/defaultChain"
import * as TronWeb from "tronweb"

// LINK to the testnet https://api.shasta.trongrid.io

export default class TRON extends DefaultChain {
    // LINK https://github.com/tronprotocol/tronweb
    // NOTE As Tron supports solidity contracts, we need to study for it quite a lot

    constructor() {
        super("https://api.shasta.trongrid.io")
        this.name = "TRON"
    }
	
    connect(rpc_url: string): boolean {
        this.provider = new TronWeb({
            fullHost: rpc_url,
        })
        return true
    }
    disconnect(): void {
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
    connectWallet(privateKey: string) {
        this.wallet = new TronWeb({
            fullHost: "https://api.shasta.trongrid.io",
            privateKey: privateKey,
        })
    }
    signTransaction(raw_transaction: any): Promise<any> {
        throw new Error("Method not implemented.")
    }
    sendTransaction(signed_transaction: any) {
        throw new Error("Method not implemented.")
    }
	
}
