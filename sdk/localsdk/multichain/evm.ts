/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/
import {
    Contract,
    JsonRpcProvider,
    parseEther,
    TransactionReceipt,
    TransactionRequest,
    Wallet,
} from "ethers"
import required from "src/utilities/required"

import defaultChainAsync, { IEVM } from "./types/defaultChainAsync"
import { TransactionResponse } from "./types/multichain"

export default class EVM extends defaultChainAsync implements IEVM {
    // A singleton for each chain_id
    private static instances: Map<number, EVM> = new Map<number, EVM>()

    // Chain properties
    provider: JsonRpcProvider = null
    wallet: Wallet = null
    empty_transaction: TransactionRequest
    isEIP1559: boolean = true

    // Specific EVM properties
    contracts: Map<string, Contract> // Will store all the contracts instances as address: ethers.Contract}

    /**
     * The Singleton's constructor should always be private to prevent direct
     * construction calls with the `new` operator.
     */

    private constructor(
        chain_id: number,
        rpc_url: string,
        isEIP1559: boolean = true,
    ) {
        super(rpc_url)
        this.name = "evm"
        this.isEIP1559 = isEIP1559
    }

    async connect(rpc_url: string) {
        console.log("Connecting EVM RPC provider: " + rpc_url)
        this.provider = new JsonRpcProvider(rpc_url)

        // INFO: Fetch network data
        const network = await this.provider.getNetwork()

        // INFO: Check if network data is truthy
        this.connected = Boolean(network.name)

        return this.connected
    }

    async disconnect() {
        // TODO
    }

    createWallet(): any {}

    // INFO Connect a wallet to the EVM provider using a private key
    connectWallet(privateKey: string): Wallet {
        this.wallet = new Wallet(privateKey, this.provider)
        this.wallet.connect(this.provider)
        return this.wallet
    }

    // INFO Getting a balance for an address
    async getBalance(address: string): Promise<string> {
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
    async pay(address: string, amount: string) {
        required(this.wallet)
        let tx = { to: address, value: parseEther(amount) }
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
        console.log(this)
        if (!this.provider) {
            throw new Error("Provider not connected")
        }
        let contract = new Contract(address, abi, this.provider)
        return contract
    }

    // INFO Here we simply return the correct skeleton for a normal transaction
    async createRawTransaction(): Promise<TransactionRequest> {
        return this.empty_transaction
    }

    async signTransaction(raw_transaction: TransactionRequest) {
        required(this.wallet)
        return await this.wallet.signTransaction(raw_transaction)
    }

    // INFO If the wallet is connected, send a transaction
    // ANCHOR MVP
    async sendTransaction(transaction: TransactionRequest) {
        if (!this.wallet) {
            throw new Error("Wallet not connected")
        }
        const txResponse = await this.wallet.sendTransaction(transaction) // NOTE It will be signed automatically
        return {
            result: "success",
            hash: txResponse.hash,
        }
    }

    async sendRawTransaction(raw_transaction: string): Promise<string> {
        // TODO
        return ""
    }

    async sendSignedTransaction(
        signed_transaction: string,
    ): Promise<TransactionResponse> {
        if (!this.provider) {
            throw new Error("Provider not connected")
        }
        const res = await this.provider.broadcastTransaction(signed_transaction)

        return {
            result: "success",
            hash: res.hash,
        }
    }

    async waitForReceipt(tx_hash: string): Promise<TransactionReceipt> {
        return await this.provider.getTransactionReceipt(tx_hash)
    }

    // REVIEW Reader for contracts
    // ANCHOR MVP
    async readFromContract(
        contract_instance: Contract,
        function_name: string,
        args: any,
    ): Promise<any> {
        return await contract_instance[function_name](...args)
    }

    // REVIEW Writer for contracts
    async writeToContract(
        contract_instance: Contract,
        function_name: string,
        args: any,
    ): Promise<any> {
        required(this.wallet)
        return await contract_instance[function_name](...args) // NOTE Ensure it is writeable i guess
    }

    // SECTION Event listener
    async listenForEvent(
        event: string,
        contract: string,
        abi: any[],
    ): Promise<any> {
        if (!this.provider) {
            throw new Error("Provider not connected")
        }
        let contractInstance = new Contract(contract, abi, this.provider)
        // REVIEW THis could work
        return contractInstance.on(event, (data: any) => {
            ////console.log(data)
            // TODO Do something with the data
        })
    }

    async listenForAllEvents(contract: string, abi: any[]): Promise<any> {
        if (!this.provider) {
            throw new Error("Provider not connected")
        }
        let contractInstance = new Contract(contract, abi, this.provider)
        // REVIEW 99% Won't work
        return contractInstance.on("*", (data: any) => {
            ////console.log(data)
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
