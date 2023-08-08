export default interface defaultChain {
	provider: any;
	wallet: any;

	connectWallet(privateKey: string): any;
	getBalance (address: string): Promise<string>;
	// INFO If the wallet is connected, send a transaction
	sendTransaction (transactions: any): any;

	
}