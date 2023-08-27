import * as solanaWeb3 from "@solana/web3.js"
import DefaultChain from "./types/defaultChain"
import required from "src/utilities/required"

/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/


// LINK https://docs.solana.com/developing/clients/javascript-api

export default class SOLANA  extends DefaultChain  {
    private static instance: SOLANA

    wallet: solanaWeb3.Keypair = null
    provider: solanaWeb3.Connection = null

    constructor(rpc_url: string) {
        super(rpc_url)
        this.name = "solana"
    }

    connect(rpc_url: string): boolean {
        this.provider = new solanaWeb3.Connection(rpc_url)
        // TODO Check connectivity
        return true
    }

    disconnect(): void {
        this.provider = null
        // TODO If something is to do, do it here
    }

    // ANCHOR Public methods
    connectWallet(privateKey: string) {
        this.wallet = solanaWeb3.Keypair.fromSecretKey(Buffer.from(privateKey, "hex")) // REVIEW is this ok?
    }

    async getBalance (address: string): Promise<string> {
        // TODO
        return ""
    }

    async pay(to: string, amount: string): Promise<any> {
        required(this.wallet, "Wallet not connected")
        // TODO
        return null
    }

    async info(): Promise<string> {
        let info = ""
        // TODO
        return info
    }

    // INFO Returning an empty raw transaction skeleton
    async createRawTransaction(): Promise<solanaWeb3.Transaction> {
        let empty_tx = new solanaWeb3.Transaction()
        return empty_tx
    }

    // INFO Placeholder compatibility function that is here only for the interface
    async signTransaction(raw_transaction: any): Promise<any> {
        required(this.wallet, "Wallet not connected")
        // LINK https://docs.shyft.to/tutorials/how-to-sign-transactions-on-solana
        // NOTE Due to the above, the transaction is signed and sent at the same time.
        return raw_transaction
    }

    // INFO Sending a transfer transaction on Solana network
    sendTransaction({to, amount}) {
        required(this.wallet, "Wallet not connected")
        let tx = new solanaWeb3.Transaction()
        tx.add(
            solanaWeb3.SystemProgram.transfer({
                fromPubkey: this.wallet.publicKey,
                toPubkey: to,
                lamports: amount * solanaWeb3.LAMPORTS_PER_SOL,
            }),
        )
        let result = solanaWeb3.sendAndConfirmTransaction(this.provider, tx, [this.wallet])
        return result
    }

    // ANCHOR Static singleton methods

    static getInstance(): SOLANA|boolean {
        if (!SOLANA.instance) {
            return false
        }
        return SOLANA.instance
    }

    static createInstance(rpc_url: string): SOLANA {
        if (!SOLANA.instance) {
            SOLANA.instance = new SOLANA(rpc_url)
        }
        return SOLANA.instance
    }
}