// NOTE We use ethers 5.7 because 6> are too weird for now to use
// LINK https://docs.ethers.org/v5/
import { ethers } from "ethers"
import required from "../../utils/required"

export default class EVM {

	constructor(rpc_url=null) {
		this.provider = null
		this.wallet = null
		if (rpc_url) {
			this.setRPC(rpc_url)
		}
    }

	// INFO Set of methods for connecting to an RPC while
	// retaining a granular control over the instance status
	async setRPC(rpc_url) {
		this.provider = new ethers.providers.JsonRpcProvider(rpc_url)
	}
	async connect() {
		console.log(this.provider)
        await this.provider.connect()
    }
	static async create(rpc_url=null) {
		let instance = new EVM(rpc_url)
		//if (rpc_url) { await instance.connect() }
		return instance
    }

	// INFO Connecting a wallet through a private key (string)
	async connectWallet(privateKey) {
		this.wallet = new ethers.Wallet(privateKey, this.provider)
	}

	// INFO Signing a transaction 
	// with a private key or by using our stored wallet
	async signTransaction(transaction, privateKey=null) {
		if (privateKey) {
			this.wallet = new ethers.Wallet(privateKey, this.provider)
        }
		// REVIEW Experimental type checking
		assert(this.wallet instanceof ethers.Wallet, "Wallet not connected")
        // And anyway, we need a wallet after all
        //if (!this.wallet) {
        //    throw new Error("Wallet not connected")
        //}
        // Finally, we can sign the transaction
        return this.wallet.signTransaction(transaction)
	}

	// SECTION Specific methods

	// REVIEW Should prepare methods be like:
	// prepare = { pay(), send(), ...}

	// INFO transfer and pay are the same 
	async prepareTransfer() {
		await this.pay()
	}
	async preparePay(address, amount) {
		required(this.wallet, "Wallet is not connected!")
		// Signing a valid transfer
        let tx = { to: address, value: ethers.utils.parseEther(amount) }
		let signedTx = await this.wallet.signTransaction(tx)
        console.log(signedTx)
        return signedTx
	}
	// !SECTION Specific methods
}