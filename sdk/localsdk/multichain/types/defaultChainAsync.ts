/* eslint-disable no-unused-vars */
/* eslint-disable no-mixed-spaces-and-tabs */
import * as ethers from "ethers"
import { Contract } from "ethers"

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

    // ANCHOR Base methods
    abstract connect(rpc_url: string): Promise<any>
    abstract disconnect(): Promise<any>
    // ANCHOR Read methods
    abstract getBalance(address: string): Promise<string>
    abstract pay(receiver: string, amount: string): Promise<any>
    abstract info(...args: any): Promise<string>
    // ANCHOR Write methods
    abstract createWallet(password?: string): any
    abstract connectWallet(privateKey: string): any
    abstract signTransaction(raw_transaction: any): Promise<any>
    abstract sendTransaction(signed_transaction: any): any

    constructor(rpcURL: string) {
        this.rpc_url = rpcURL
        this.connected = false
    }
}

// INFO This interface is exclusive for the EVM networks
// TODO Fill it more
export interface IEVM {
    contracts: Map<string, ethers.Contract>
    isEIP1559: boolean
    getContractInstance: (address: string, abi: string) => Promise<Contract>
    createRawTransaction: (tx_data: any) => Promise<any>
    readFromContract: (contract: any, method: string, args: any) => Promise<any>
    writeToContract: (contract: any, method: string, args: any) => Promise<any>
    listenForEvent: (
        event: string,
        contract: string,
        abi: any[],
    ) => Promise<any>
    listenForAllEvents: (contract: string, abi: any[]) => Promise<any>
    waitForReceipt: (
        tx_hash: string,
    ) => Promise<ethers.providers.TransactionReceipt>
    // The following methods are to be redirected to defaultChain methods (see evm implementation)
    transfer: any
}
