// INFO This module exposes a set of method for crosschain interoperability (READ and WRITE - send transactions)
// NOTE It works for EVM chains, Bitcoin, Solana and Polkadot.
//

import { sha256 } from "node-forge"
import { TransactionContent } from "../blockchain/types/transactions"
import { JsonRpcProvider } from "@ethersproject/providers"
import { Wallet } from "@ethersproject/wallet"
import fetch from 'node-fetch'
import { ECPair, TransactionBuilder, networks } from 'bitcoinjs-lib'
import axios from 'axios'
import { TransactionRequest } from "@ethersproject/providers"
//import { BigNumber } from "ethers"
//import { Connection } from '@solana/web3.js'
//import { PublicKey } from '@solana/web3.js'

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
            const keyPair = ECPair.fromWIF(privateKey, networks.bitcoin);
            const txb = new TransactionBuilder(networks.bitcoin);

            const txData = await axios.get(`https://blockchain.info/unspent?active=${from}`);
            const inputs = txData.data.unspent_outputs;

            let totalValue = 0;
            for (let input of inputs) {
                txb.addInput(input.tx_hash_big_endian, input.tx_output_n);
                totalValue += input.value;
                if (totalValue >= value) break;
            }

            if (totalValue < value) throw new Error("Insufficient funds");

            const fee = 10000; // Set transaction fee here (in Satoshis)
            const sendValue = totalValue - fee;

            txb.addOutput(to, sendValue);
            if (totalValue > sendValue) {
                // Create change output
                txb.addOutput(from, totalValue - sendValue - fee);
            }

            for (let i = 0; i < inputs.length; i++) {
                txb.sign(i, keyPair);
            }

            const rawTransaction = txb.build().toHex();

            const response = await axios.post('https://api.blockcypher.com/v1/btc/main/txs/push', {
                tx: rawTransaction,
            });
            return response.data.hash;
        },
    },
    
    //NOTE: Solana is not supported yet
    /*
    solana: {
        provider: null,
        connect: async function(rpc: string, private_key: string | null = null) {
            const conn = new Connection(rpc, "confirmed")
            if (private_key) {
                const wallet = new Wallet(new Uint8Array(JSON.parse(private_key)), conn)
                this.provider = wallet
            } else {
                this.provider = conn
            }
            return this.provider
        },
        getBalance: async function(this: Chain, address: string) {
            const balance = await this.provider!.getBalance(new PublicKey(address))
            return balance.toString()
        },
    },
    */
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