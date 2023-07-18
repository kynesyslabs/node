/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { sha256 } from "node-forge"
import { TransactionContent } from "../../libs/blockchain/types/transactions"
import { JsonRpcProvider } from "@ethersproject/providers"
import { Wallet } from "@ethersproject/wallet"
import fetch from 'node-fetch'
import { Psbt, networks } from 'bitcoinjs-lib'
import fromWIF  from 'bip32'
import axios from 'axios'
import { TransactionRequest } from "@ethersproject/providers"
import { ethers } from 'ethers'

interface TransactionParams {
    from: string
    to: string
    value: number
    privateKey: string
}

interface Chain {
    provider: JsonRpcProvider | null
    connect: (rpc: string, private_key?: string | null) => Promise<JsonRpcProvider>
    getBalance: (address: string) => Promise<string>
    sendTransaction: (transaction: TransactionRequest | TransactionParams) => Promise<string>
}

const chains: { [key: string]: Chain } = {
    evm: {
        provider: null,
        connect: async function(rpc: string, private_key: string | null = null) {
            const provider = new JsonRpcProvider(rpc)
            if (private_key) {
                const wallet = new Wallet(private_key, provider)
                this.provider = wallet.connect(provider)
            } else {
                this.provider = provider
            }
            return this.provider
        },
        getBalance: async function(this: Chain, address: string) {
            const balance = await this.provider!.getBalance(address)
            return balance.toString()
        },
        sendTransaction: async function(this: Chain, transaction: TransactionRequest) {
            if (!this.provider) throw new Error("Provider is not connected");
            const signer = this.provider.getSigner();
            const txResponse = await signer.sendTransaction(transaction);
            return txResponse.hash;
        },
    },
    btc: {
        provider: null,
        connect: async function(rpc: string, private_key: string | null = null) {
            const provider = new JsonRpcProvider(rpc)
            if (private_key) {
                const wallet = new Wallet(private_key, provider)
                this.provider = wallet.connect(provider)
            } else {
                this.provider = provider
            }
            return this.provider
        },
        getBalance: async function(this: Chain, address: string) {
            const response = await fetch(`https://blockchain.info/q/addressbalance/${address}`)
            const balance = await response.text()
            return balance
        },
        sendTransaction: async function(this: Chain, { from, to, value, privateKey }: TransactionParams) {
            const keyPair = fromWIF(privateKey, networks.bitcoin);
            const psbt = new Psbt({ network: networks.bitcoin });

            const txData = await axios.get(`https://blockchain.info/unspent?active=${from}`);
            const inputs = txData.data.unspent_outputs;

            let totalValue = 0;
            for (let input of inputs) {
                psbt.addInput({
                    hash: input.tx_hash_big_endian,
                    index: input.tx_output_n,
                });
                totalValue += input.value;
                if (totalValue >= value) break;
            }

            if (totalValue < value) throw new Error("Insufficient funds");

            const fee = 10000; // Set transaction fee here (in Satoshis)
            const sendValue = totalValue - fee;

            psbt.addOutput({
                address: to,
                value: sendValue,
            });
            if (totalValue > sendValue) {
                // Create change output
                psbt.addOutput({
                    address: from,
                    value: totalValue - sendValue - fee,
                });
            }

            for (let i = 0; i < inputs.length; i++) {
                psbt.signInput(i, keyPair);
            }

            psbt.finalizeAllInputs();

            const rawTransaction = psbt.extractTransaction().toHex();

            const response = await axios.post('https://api.blockcypher.com/v1/btc/main/txs/push', {
                tx: rawTransaction,
            });
            return response.data.hash;
        },
    },
}

function generateTransactionId(transaction: TransactionContent): string {
    const transactionId = sha256
        .create()
        .update(JSON.stringify(transaction))
        .digest()
        .toHex()
    return transactionId
}

export default chains
export { generateTransactionId }

