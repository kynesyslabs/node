/* eslint-disable no-unused-vars */
/* eslint-disable no-mixed-spaces-and-tabs */
import * as ethers from "ethers"
export interface IDefaultChain {
	provider: any
	signer: any
	wallet: any
	rpc_url: string
	connected: boolean;

	connect: (url: string) => boolean;
	disconnect: () => void;
	createWallet: () => any;
	connectWallet: (privateKey: string)=> any;
	getBalance: (address: string) => Promise<string>
	pay: (receiver: string, amount: string) => Promise<any>
	info: ()=> Promise<string>
	signTransaction: (raw_transaction: any) => Promise<any>
	sendTransaction: (transactions: any) => any;

	
}

// INFO This interface is exclusive for the EVM networks
// TODO Fill it more
export interface IEVM {
	contracts: Map<string, ethers.Contract>
	createRawTransaction: (tx_data: any) => Promise<any>
	readFromContract: (contract: any, method: string, args: any) => Promise<any>
	writeToContract: (contract: any, method: string, args: any) => Promise<any>
}

export default abstract class DefaultChain implements IDefaultChain {
    provider: any
    name: string
    signer: any
    wallet: any
    rpc_url: string
    connected: boolean

	// ANCHOR Base methods
	abstract connect(rpc_url: string): boolean;
	abstract disconnect(): void;
	// ANCHOR Read methods
	abstract getBalance(address: string): Promise<string>;
	abstract pay(receiver: string, amount: string): Promise<any>;
	abstract info(...args: any): Promise<string>;
	// ANCHOR Write methods
	abstract createWallet(): any;
	abstract connectWallet(privateKey: string): any;
	abstract signTransaction(raw_transaction: any): Promise<any>
	abstract sendTransaction(signed_transaction: any): any;


	constructor(rpcURL: string) {
	    this.rpc_url = rpcURL
	    this.connected = this.connect(rpcURL)
	}
}