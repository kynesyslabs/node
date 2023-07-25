/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import * as xrpl from "xrpl"
import xrplWSListeners from "./types/xrpl_ws_listeners"
import * as WebSocket from "ws"
import defaultChain from "./types/defaultChain"

// LINK https://js.xrpl.org/

// TODO https://xrpl.org/monitor-incoming-payments-with-websocket.html

export default class XRPL  implements defaultChain {
    provider: xrpl.Client
    socket: WebSocket
    wallet: xrpl.Wallet

    constructor() {
        this.provider = null
        this.wallet = null
        this.socket = null
    }

    // SECTION Initializations

    // INFO Connects to a XRP rpc server
    public async connect(rpc: string) {
        this.provider = new xrpl.Client(rpc)
        await this.provider.connect()
        this.socket = new WebSocket(rpc)
        await xrplWSListeners(this.socket)
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

    // INFO Generic sign, send and await (if not specified) a tx
    async sendTransaction(prepared: any, wait:boolean=true): Promise<xrpl.TxResponse> {
        // Signing the tx
        let signed = this.wallet.sign(prepared)
        console.log("[*] Tx Hash: " + signed.hash)
        // Sending the tx
        let tx_promise = this.provider.submitAndWait(signed.tx_blob)
        if (wait) {
            return await tx_promise
        } else {
            return tx_promise
        }
    }

    // INFO Sending XRP to an address
    async pay(receiver: string, amount: number): Promise<xrpl.TxResponse> {
        // Preparing a payment tx
        const prepared = await this.provider.autofill({
            "TransactionType": "Payment",
            "Account": this.wallet.address,
            "Amount": xrpl.xrpToDrops(amount),
            "Destination": receiver,
        })

        // FIXME See below
        /*const max_ledger = prepared.LastLedgerSequence
		console.log("Prepared transaction instructions:", prepared)
		console.log("Transaction cost:", xrpl.dropsToXrp(prepared.Fee), "XRP")
		console.log("Transaction expires after ledger:", max_ledger) */
        return await this.sendTransaction(prepared)
    }


    // !SECTION Writes

    // INFO Manages a clean exit
    disconnect() {
        this.provider.disconnect()
    }

}