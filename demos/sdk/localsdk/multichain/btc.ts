/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { sha256 } from "node-forge"
import fetch from "node-fetch"
import { Psbt, networks } from "bitcoinjs-lib"
import fromWIF from "bip32"
import axios from "axios"
import { TransactionRequest } from "@ethersproject/providers"
import { JsonRpcProvider } from "@ethersproject/providers"
import { Wallet } from "@ethersproject/wallet"
import DefaultChain from "./types/defaultChain"
import { TransactionContent } from "../../../src/libs/blockchain/types/transactions"


interface TransactionParams {
    from: string
    to: string
    value: number
    privateKey: string
}


export default class BTC  extends DefaultChain {
    private static instance: BTC
    provider: JsonRpcProvider
    wallet: Wallet

    constructor(rpc_url: string) {
        this.provider = new JsonRpcProvider(rpc_url)
    }

    async connect(private_key: string): Promise<void> {
        const wallet = new Wallet(private_key, this.provider)
    }

    async getBalance(address: string): Promise<string> {
        const response = await fetch(
            `https://blockchain.info/q/addressbalance/${address}`,
        )
        const balance = await response.text()
        return balance
    }

    async sendTransaction(
        { from, to, value }: TransactionParams,
    ) {
        if (!this.wallet) { throw new Error("Wallet not connected") }
		
        const keyPair = fromWIF(this.wallet.privateKey, networks.bitcoin)
        const psbt = new Psbt({ network: networks.bitcoin })

        const txData = await axios.get(
            `https://blockchain.info/unspent?active=${from}`,
        )
        const inputs = txData.data.unspent_outputs

        let totalValue = 0
        for (let input of inputs) {
            psbt.addInput({
                hash: input.tx_hash_big_endian,
                index: input.tx_output_n,
            })
            totalValue += input.value
            if (totalValue >= value) break
        }

        if (totalValue < value) throw new Error("Insufficient funds")

        const fee = 10000 // Set transaction fee here (in Satoshis)
        const sendValue = totalValue - fee

        psbt.addOutput({
            address: to,
            value: sendValue,
        })
        if (totalValue > sendValue) {
            // Create change output
            psbt.addOutput({
                address: from,
                value: totalValue - sendValue - fee,
            })
        }

        for (let i = 0; i < inputs.length; i++) {
            psbt.signInput(i, keyPair) // FIXME Here
        }

        psbt.finalizeAllInputs()

        const rawTransaction = psbt.extractTransaction().toHex()

        const response = await axios.post(
            "https://api.blockcypher.com/v1/btc/main/txs/push",
            {
                tx: rawTransaction,
            },
        )
        return response.data.hash
    }

    // Static singleton puller
    public static getInstance(): BTC|boolean {
        if (!BTC.instance) {
            return false
        }
        return BTC.instance
    }

    public static createInstance(rpc_url: string): BTC {
        if (!BTC.instance) {
            BTC.instance = new BTC(rpc_url)
        }
        return BTC.instance
    }
}
