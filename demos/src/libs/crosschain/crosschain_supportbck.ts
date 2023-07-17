// INFO This module exposes a set of method for crosschain interoperability (READ and WRITE - send transactions)
// NOTE It works for EVM chains, Bitcoin, Solana and Polkadot.
//

import { sha256 } from "node-forge"
import { TransactionContent } from "../blockchain/types/transactions"
import { JsonRpcProvider } from "@ethersproject/providers"
import { Wallet } from "@ethersproject/wallet"
import fetch from 'node-fetch'
import { Connection } from '@solana/web3.js'


interface Chain {
    provider: JsonRpcProvider | null
    connect: (rpc: string, private_key?: string | null) => Promise<JsonRpcProvider>
    getBalance: (address: string) => Promise<string>
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
    },
    solana: {
        provider: null,
        connect: async function(rpc: string, private_key: string | null = null) {
            const connection = new Connection(rpc, 'confirmed')
            if (private_key) {
                const wallet = new Wallet(private_key)
                this.provider = wallet.connect(connection)
            } else {
                this.provider = connection
            }
            return this.provider
        },
        getBalance: async function(this: Chain, address: string) {
            const balance = await this.provider!.getBalance(new PublicKey(address))
            return balance.toString()
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