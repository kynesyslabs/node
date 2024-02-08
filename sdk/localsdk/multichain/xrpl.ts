/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import * as xrpl from "xrpl"
// import WebSocket from "ws" // NOTE tsx compatibility
import DefaultChainAsync from "./types/defaultChainAsync"
import { chainProviders } from "./configs/chainProviders"
import chain from "src/libs/blockchain/chain"

// LINK https://js.xrpl.org/

// TODO https://xrpl.org/monitor-incoming-payments-with-websocket.html

export default class XRPL extends DefaultChainAsync {
    provider: xrpl.Client = null
    wallet: xrpl.Wallet = null

    constructor(rpc_url: string) {
        super(rpc_url) // overwrote -> (rpc_url)
        this.name = "xrpl"
    }

    // SECTION Initializations

    // INFO Connects to a XRP rpc server
    public async connect(rpc: string): Promise<any> {
        this.provider = new xrpl.Client(rpc)
        await this.provider.connect()
        this.connected = true
        return this.provider
    }

    // INFO Manages a clean exit
    public async disconnect(): Promise<any> {
        await this.provider.disconnect()
        this.connected = false
        return true
    }

    // INFO Connects to a wallet on XRPL
    async connectWallet(seed: string) {
        this.wallet = xrpl.Wallet.fromSeed(seed)
    }

    // INFO Creates a new wallet
    async createWallet() {
        this.wallet = xrpl.Wallet.generate()
    }

    // !SECTION Initializations

    // SECTION Reads

    // INFO Generic account info
    async accountInfo(address: string): Promise<xrpl.AccountInfoResponse> {
        return await this.provider.request({
            command: "account_info",
            account: address,
            ledger_index: "validated",
        })
    }

    // INFO Getting balance for an address (supports both XRP and other tokens)
    async getBalance(address: string, multi: boolean = true) {
        let response = null
        if (multi) {
            response = await this.provider.getBalances(address)
        } else {
            response = await this.provider.getXrpBalance(address)
        }
        return response
    }

    // !SECTION Reads

    // SECTION Writes

    // INFO Sending XRP to an address
    // ANCHOR MVP
    async pay(
        receiver: string,
        amount: string,
        send: boolean = true,
    ): Promise<any> {
        // Preparing a payment tx
        const prepared = await this.provider.autofill({
            TransactionType: "Payment",
            Account: this.wallet.address,
            Amount: xrpl.xrpToDrops(amount),
            Destination: receiver,
        })

        // FIXME See below
        /*const max_ledger = prepared.LastLedgerSequence
		console.log("Prepared transaction instructions:", prepared)
		console.log("Transaction cost:", xrpl.dropsToXrp(prepared.Fee), "XRP")
		console.log("Transaction expires after ledger:", max_ledger) */
        if (send) {
            console.log("Sending transaction...")
            console.log(prepared)
            return await this.sendTransaction(prepared)
        } else {
            // Just signing the tx
            let signed = this.wallet.sign(prepared)
            return signed
        }
    }

    async info(): Promise<string> {
        let info = ""
        // TODO Implement
        return info
    }

    async signTransaction(raw_transaction: any): Promise<any> {
        // Signing the tx
        let signed = this.wallet.sign(raw_transaction)
        console.log("Hash: " + signed.hash)
        console.log("Blob: " + signed.tx_blob)
        return signed
    }

    // INFO Generic sign, send and await (if not specified) a tx
    async sendTransaction(
        signed: any,
        wait: boolean = true,
    ): Promise<xrpl.TxResponse> {
        // Sending the tx
        console.log("[xrpl] sendtransaction")
        let tx_promise = this.provider.submitAndWait(signed.tx_blob)
        console.log(`[xrpl] tx promise:`)
        console.log(tx_promise)
        if (wait) {
            return await tx_promise
        } else {
            return tx_promise
        }
    }
    ok

    // !SECTION Writes
}
