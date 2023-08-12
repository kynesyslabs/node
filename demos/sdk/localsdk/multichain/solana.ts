/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import * as solanaWeb3 from "@solana/web3.js"
import defaultChain from "./types/defaultChain"

// LINK https://docs.solana.com/developing/clients/javascript-api

export default class SOLANA  implements defaultChain  {
    private static instance: SOLANA

    wallet: solanaWeb3.Keypair
    provider: solanaWeb3.Connection

    constructor(rpc_url: string) {
        this.provider = new solanaWeb3.Connection(rpc_url)
    }

    // ANCHOR Public methods
    connectWallet(privateKey: string) {
        this.wallet = solanaWeb3.Keypair.fromSecretKey(Buffer.from(privateKey, "hex")) // REVIEW is this ok?
    }

    async getBalance (address: string): Promise<string> {
        // TODO
        return ""
    }

    // INFO Sending a transfer transaction on Solana network
    sendTransaction({to, amount}) {
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