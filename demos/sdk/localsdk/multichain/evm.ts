/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/
import * as ethers from "ethers"
import { JsonRpcProvider } from "@ethersproject/providers"
import { Wallet } from "@ethersproject/wallet"
import { TransactionRequest } from "@ethersproject/providers"
import { Contract } from "ethers"
import DefaultChain from "./types/defaultChain"
import { IEVM } from "./types/defaultChain"
import required from "src/utilities/required"
import { sign } from "crypto"
import { evmProviders } from "./configs/evmProviders"


export default class EVM extends DefaultChain implements IEVM {
    // A singleton for each chain_id
    private static instances: Map<number, EVM> = new Map<number, EVM>()
    // Chain properties
    provider: JsonRpcProvider = null
    wallet: Wallet = null
    empty_transaction: TransactionRequest
    // Specific EVM properties
    contracts: Map<string, ethers.Contract> // Will store all the contracts instances as address: ethers.Contract}

    /**
     * The Singleton's constructor should always be private to prevent direct
     * construction calls with the `new` operator.
     */

    private constructor(chain_id: number, rpc_url: string) {
        super(rpc_url)
        this.name = "evm"
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

    createWallet(): any {
        
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

    // Redirection
    async transfer(receiver: string, amount: string): Promise<any> {
        return await this.pay(receiver, amount)
    }

    // INFO Simply sending an amount to an address
    // NOTE Returns the transaction hash as a string
    // ANCHOR MVP
    async pay(address: string, amount: string): Promise<string> {
        required(this.wallet)
        let tx = { to: address, value: ethers.utils.parseEther(amount) }
        let tx_hashed = await this.sendTransaction(tx)
        console.log(tx_hashed)
        return tx_hashed
    }

    async info(): Promise<string> {
        let info = ""
        // TODO
        return info
    }

    async getContractInstance(address: string, abi: string): Promise<Contract> {
        required(this.provider)
        let contract = new Contract(address, abi, this.provider)
        return contract
    }

    // INFO Here we simply return the correct skeleton for a normal transaction
    async createRawTransaction(): Promise<TransactionRequest> {
        return this.empty_transaction
    }

    async signTransaction(raw_transaction: TransactionRequest): Promise<any> {
        required(this.wallet)
        return await this.wallet.signTransaction(raw_transaction)
    }

    // INFO If the wallet is connected, send a transaction
    // ANCHOR MVP
    async sendTransaction (transaction: TransactionRequest): Promise<string> {
        if (!this.wallet) { throw new Error("Wallet not connected") }
        const txResponse = await this.wallet.sendTransaction(transaction) // NOTE It will be signed automatically
        return txResponse.hash
    }

    async sendRawTransaction (raw_transaction: string): Promise<string> {
        // TODO
        return ""
    }

    async sendSignedTransaction (signed_transaction: string): Promise<any> {
        // TODO
        if (!this.provider) { throw new Error("Provider not connected") }
        return await this.provider.sendTransaction(signed_transaction)
    }

    async waitForReceipt (tx_hash: string): Promise<ethers.ethers.providers.TransactionReceipt> {
        return await this.provider.getTransactionReceipt(tx_hash)
    }

    // REVIEW Reader for contracts
    // ANCHOR MVP
    async readFromContract(contract_instance: Contract, function_name: string, args: any): Promise<any> {
        return await contract_instance[function_name](...args)
    }

    // REVIEW Writer for contracts
    async writeToContract(contract_instance: Contract, function_name: string, args: any): Promise<any> {
        required(this.wallet)
        return await contract_instance[function_name](...args) // NOTE Ensure it is writeable i guess
    }

    // SECTION Event listener
    async listenForEvent(event: string, contract: string, abi: any[]): Promise<any> {
        required(this.provider)
        let contractInstance = new ethers.Contract(contract, abi, this.provider)
        // REVIEW THis could work
        return contractInstance.on(event, (data: any) => {
            console.log(data)
            // TODO Do something with the data
        })
    }

    async listenForAllEvents(contract: string, abi: any[]): Promise<any> {
        required(this.provider)
        let contractInstance = new ethers.Contract(contract, abi, this.provider)
        // REVIEW 99% Won't work
        return contractInstance.on("*", (data: any) => {
            console.log(data)
            // TODO Do something with the data
        })
    }
    // !SECTION Event Listener

    /**
     * The static method that controls the access to the singleton instance.
     *
     * This implementation let you subclass the Singleton class while keeping
     * just one instance of each subclass around.
     */

    // INFO Getting an instance (if it exists) or false so that we can call createInstance
    public static getInstance(chain_id: number): EVM {
        if (!EVM.instances[chain_id]) {
            return null
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