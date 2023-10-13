import * as xrpl from "xrpl"
import required from "../../utils/required"

export default class XRPL {

	// NOTE We init XRPL with await XRPL.create(rpc_url)
	// This is necessary to ensure that the provider is connected
	// if the user specifies the rpc_url in the constructor,
	// as we cannot use await in the constructor
	constructor(rpc_url=null) {
		this.wallet = null
		this.provider = null
		if (rpc_url) {
			this.setRPC(rpc_url)
		}
    }

	// INFO Set of methods for connecting to an RPC while
	// retaining a granular control over the instance status
	async setRPC(rpc_url) {
		this.provider = new xrpl.Client(rpc_url)
	}
	async connect() {
        await this.provider.connect()
    }
	static async create(rpc_url=null) {
		let instance = new XRPL(rpc_url)
		if (rpc_url) { await instance.connect() }
		return instance
    }

	// INFO Connecting a wallet through a private key (string)
	async connectWallet(privateKey) {
		this.wallet = xrpl.Wallet.fromSeed(privateKey)
	}

	// INFO Signing a transaction 
	// with a private key or by using our stored wallet
	async signTransaction(transaction, privateKey=null) {
		// If provided, we can use the user's private key
		if (privateKey) {
			this.wallet = xrpl.Wallet.fromSeed(privateKey)
		}
		// REVIEW Experimental type checking
		assert(this.wallet instanceof xrpl.Wallet, "Wallet not connected")
		// And anyway, we need a wallet after all
		//if (!this.wallet) {
        //    throw new Error("Wallet not connected")
        //}
		// Finally, we can sign the transaction
        return this.wallet.sign(transaction)
	}

	// SECTION Specific methods

	// INFO transfer and pay are the same 
	async prepareTransfer() {
		await this.pay()
	}
	async preparePay(address, amount) {
		required(this.wallet, "Wallet is not connected!")
		// Signing a valid transfer
		let tx = await this.provider.autofill({
            "TransactionType": "Payment",
            "Account": this.wallet.address,
            "Amount": xrpl.xrpToDrops(amount),
            "Destination": address,
        })
		let signedTx = await this.wallet.sign(tx) // REVIEW Is this all?
		console.log(signedTx)
		return signedTx
	}
	// !SECTION Specific methods

	// INFO Generic empty tx skeleton for this chain
	async getEmptyTransaction() {
		// TODO
	}

	//megabudino was here – return the address of the wallet
	getAddress()
	{
		return this.wallet.address;
	}
}