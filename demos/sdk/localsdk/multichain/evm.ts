/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/
import { ethers } from "ethers"
import { JsonRpcProvider } from "@ethersproject/providers"
import { JsonRpcSigner } from "@ethersproject/providers"
import { Wallet } from "@ethersproject/wallet"
import { TransactionRequest } from "@ethersproject/providers"
import DefaultChain from "./types/defaultChain"


export default class EVM  extends DefaultChain {
    // A singleton for each chain_id
    private static instances: Map<number, EVM> = new Map<number, EVM>()
    // Chain properties
    provider: JsonRpcProvider = null
    wallet: Wallet = null

    /**
     * The Singleton's constructor should always be private to prevent direct
     * construction calls with the `new` operator.
     */

    private constructor(chain_id: number, rpc_url: string) {
        super(rpc_url)
    }

    connect(rpc_url: string): boolean{
        this.provider = new JsonRpcProvider(rpc_url)
        // TODO Check network connectivity and id
        this.connected = true
        return true
    }

    disconnect() {
        // TODO
    }

    // INFO Connect a wallet to the EVM provider using a private key
    connectWallet(privateKey: string): Wallet {
        this.wallet = new Wallet(privateKey, this.provider)
        this.wallet.connect(this.provider)
        return this.wallet
    }

    // INFO Getting a balance for an address
    async getBalance (address: string): Promise<string> {
        const balance = await this.provider.getBalance(address)
        return balance.toString()
    }

    // INFO If the wallet is connected, send a transaction
    async sendTransaction (transaction: TransactionRequest): Promise<string> {
        if (!this.wallet) { throw new Error("Wallet not connected") }
        const txResponse = await this.wallet.sendTransaction(transaction)
        return txResponse.hash
    }

    async pay(address: string, amount: string): Promise<any> {
        // TODO
    }

    async info(): Promise<string> {
        let info = ""
        // TODO
        return info
    }

    /**
     * The static method that controls the access to the singleton instance.
     *
     * This implementation let you subclass the Singleton class while keeping
     * just one instance of each subclass around.
     */

    // INFO Getting an instance (if it exists) or false so that we can call createInstance
    public static getInstance(chain_id: number): boolean|EVM {
        if (!EVM.instances[chain_id]) {
            return false
        }
        return EVM.instances[chain_id]
    }

    // INFO Creating an instance from a rpc url if not already created
    public static createInstance(chain_id: number, rpc_url: string): EVM {
        if (!EVM.instances[chain_id]) {
            EVM.instances[chain_id] = new EVM(chain_id, rpc_url)
        }
        return EVM.instances[chain_id]
    }
}