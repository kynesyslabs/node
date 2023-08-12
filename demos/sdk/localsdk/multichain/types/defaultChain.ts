/* eslint-disable no-mixed-spaces-and-tabs */
export interface IDefaultChain {
	provider: any
	signer: any
	wallet: any
	rpc_url: string
	connected: boolean;

	connect: (url: string) => boolean;
	disconnect: () => void;
	connectWallet: (privateKey: string)=> any;
	getBalance: (address: string) => Promise<string>
	pay: (receiver: string, amount: string) => Promise<any>
	info: ()=> Promise<string>
	sendTransaction: (transactions: any) => any;

	
}

export default abstract class DefaultChain implements IDefaultChain {
    provider: any
    signer: any
    wallet: any
    rpc_url: string
    connected: boolean

	abstract connect(rpc_url: string): boolean;
	abstract disconnect(): void;
	abstract connectWallet(privateKey: string): any;
	abstract getBalance(address: string): Promise<string>;
	abstract pay(receiver: string, amount: string): Promise<any>;
	abstract info(): Promise<string>;
	abstract sendTransaction(transactions: any): any;


	constructor(rpcURL: string) {
	    this.rpc_url = rpcURL
	    this.connected = this.connect(rpcURL)
	}
}