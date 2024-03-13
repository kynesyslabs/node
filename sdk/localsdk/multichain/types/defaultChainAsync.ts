/* eslint-disable no-unused-vars */
/* eslint-disable no-mixed-spaces-and-tabs */
import * as ethers from "ethers"

import { TransactionResponse } from "./multichain"

/*
 * INFO This class allows to create chains objects that await asynchronously for connections
 */

// TODO Make this the default way of composing chain objects (see xrpl and evm)

export interface IDefaultChainAsync {
    provider: any
    signer: any
    wallet: any
    rpc_url: string
    connected: boolean

    connect: (url: string) => Promise<any>
    disconnect: () => Promise<any>
    createWallet: () => any
    connectWallet: (privateKey: string) => any
    getBalance: (address: string) => Promise<string>
    pay: (receiver: string, amount: string) => Promise<any>
    info: () => Promise<string>
    signTransaction: (raw_transaction: any) => Promise<any>
    sendTransaction: (transactions: any) => any
}

// INFO Async chains must call and await .connect() to connect to the network
export default abstract class DefaultChainAsync implements IDefaultChainAsync {
    provider: any
    name: string
    signer: any
    wallet: any
    rpc_url: string
    connected: boolean

    constructor(rpcURL: string) {
        this.rpc_url = rpcURL
        this.connected = false
    }

    // ANCHOR Base methods

    /**
     * Connects to the RPC provider
     * @param url The RPC URL of the chain
     * @returns A boolean that resolves to true if the connection was successful
     */
    abstract connect(rpc_url: string): Promise<boolean>

    /**
     * Disconnects from the RPC provider.
     */
    abstract disconnect(): Promise<any>
    // ANCHOR Read methods

    /**
     * Gets the balance of an address
     * @param address The address to get the balance from
     * @returns A promise that resolves to the balance of the address
     */
    abstract getBalance(address: string): Promise<string>

    /**
     * Creates a transaction to send the default currency of the chain to an address
     * @param receiver The address of the receiver
     * @param amount The amount to send
     * @returns A promise that resolves to the signed transaction
     */
    abstract pay(receiver: string, amount: string): Promise<any>
    abstract info(...args: any): Promise<string>
    // ANCHOR Write methods

    /**
     * Creates a wallet
     * @param password The password to encrypt the wallet
     * @returns The wallet
     */
    abstract createWallet(password?: string): any

    /**
     * Connects to a wallet for signing transactions using a private key
     * @param privateKey The private key of the wallet
     * @returns The signer object
     */
    abstract connectWallet(privateKey: string): any

    /**
     * Signs a transaction
     * @param raw_transaction The transaction to sign
     * @returns A promise that resolves to the signed transaction
     */
    abstract signTransaction(raw_transaction: any): Promise<any>

    /**
     * Broadcasts a signed transaction using the RPC provider
     * @param signed_transaction The signed transaction
     * @returns A promise that resolves to the transaction hash
     */
    abstract sendTransaction(
        signed_transaction: any,
    ): Promise<TransactionResponse>
}

// INFO This interface is exclusive for the EVM networks
// TODO Fill it more
export interface IEVM {
    contracts: Map<string, ethers.Contract>
    isEIP1559: boolean
    getContractInstance: (
        address: string,
        abi: string,
    ) => Promise<ethers.Contract>
    createRawTransaction: (tx_data: any) => Promise<any>
    readFromContract: (contract: any, method: string, args: any) => Promise<any>
    writeToContract: (contract: any, method: string, args: any) => Promise<any>
    listenForEvent: (
        event: string,
        contract: string,
        abi: any[],
    ) => Promise<any>
    listenForAllEvents: (contract: string, abi: any[]) => Promise<any>
    waitForReceipt: (tx_hash: string) => Promise<ethers.TransactionReceipt>
    // The following methods are to be redirected to defaultChain methods (see evm implementation)
    transfer: any
}
