import BIP32Factory, { BIP32Interface } from "bip32"
import * as bip39 from "bip39"
import * as bitcoin from "bitcoinjs-lib"
import * as ecc from "tiny-secp256k1"

import defaultChainAsync from "./types/defaultChainAsync"

const bip32 = BIP32Factory(ecc)

// NOTE BIP32 implementation follows:
// LINK https://github.com/bitcoinjs/bitcoinjs-lib/blob/master/test/integration/bip32.spec.ts

export default class BTC extends defaultChainAsync {
    constructor(rpc_url: string) {
        super(rpc_url)
        this.name = "BTC"
    }

    async connect(rpc_url: string): Promise<boolean> {
        throw new Error("Method not implemented.")
    }
    async disconnect(): Promise<any> {
        throw new Error("Method not implemented.")
    }
    async getBalance(address: string): Promise<string> {
        const response = await fetch(
            `https://blockchain.info/q/addressbalance/${address}`,
        )
        const balance = await response.text()
        return balance
    }

    pay(receiver: string, amount: string): Promise<any> {
        throw new Error("Method not implemented.")
    }
    async info(account: BIP32Interface): Promise<string> {
        let address = bitcoin.payments.p2pkh({
            pubkey: account.publicKey,
        }).address!
        return JSON.stringify(address)
    }

    createWallet(): any {
        // TODO Generate mnemonic
        let mnemonic
        let path = "m/0'/0/0"
        let seed = bip39.mnemonicToSeedSync(mnemonic)
        let root = bip32.fromSeed(seed)
        this.wallet = root.derivePath(path) // REVIEW is this right?
    }

    // INFO Accepting base58 encoded private keys like:
    // tprv8ZgxMBicQKsPd7Uf69XL1XwhmjHopUGep8GuEiJDZmbQz6o58LninorQAfcKZWARbtRtfnLcJ5MQ2AtHcQJCCRUcMRvmDUjyEmNUWwx8UbK
    // NOTE Alternatively you can pass in a mnemonic phrase to generate the private key.
    connectWallet(privateKey: string, mnemonic: boolean = false) {
        if (!mnemonic) {
            this.wallet = bip32.fromBase58(privateKey)
        } else {
            // Generating the seed and the private key from the mnemonic
            let seed = bip39.mnemonicToSeedSync(privateKey)
            let node = bip32.fromSeed(seed)
            let strng = node.toBase58()
            this.wallet = bip32.fromBase58(strng)
        }
    }
    signTransaction(raw_transaction: any): Promise<any> {
        throw new Error("Method not implemented.")
    }
    sendTransaction(signed_transaction: any) {
        throw new Error("Method not implemented.")
    }
}
