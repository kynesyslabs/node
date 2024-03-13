/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

// LINK https://github.com/stellar/js-stellar-sdk/tree/master/docs/reference

import required from "src/utilities/required"
import * as StellarSdk from "stellar-sdk"

import Server from "../../../src/libs/network/server"
import defaultChainAsync from "./types/defaultChainAsync"

// TODO Find a way to make things in the next link much more unified
// LINK https://github.com/stellar/js-stellar-base/blob/master/docs/reference/building-transactions.md
export default class XLM extends defaultChainAsync {
    constructor(rpcURL: string) {
        super(rpcURL)
        this.name = "xlm"
    }

    public async connect(rpcURL: string): Promise<boolean> {
        console.log("stellar not yet implemented. check the code")
        process.exit(0)
        // this.provider = new StellarSdk(rpcURL) // 'https://horizon-testnet.stellar.org' // FIXME
        return true
    }

    public async disconnect(): Promise<any> {
        throw new Error("Method not implemented.")
    }

    createWallet(): any {}

    // INFO Loading a keypair from a private key string
    connectWallet(privateKey: string) {
        this.wallet = StellarSdk.Keypair.fromSecret(privateKey)
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

    // REVIEW Signing a pre built transaction
    async signTransaction(raw_transaction: any): Promise<any> {
        required(this.wallet, "Wallet not connected")
        let signed_tx = await raw_transaction.sign(this.wallet)
        return signed_tx
    }

    sendTransaction(transactions: any) {
        throw new Error("Method not implemented.")
    }
}
