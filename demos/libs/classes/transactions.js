// INFO This defines a transaction class
// FIXME Merge into chain.js

var ellipticcurve = require("starkbank-ecdsa")
var Ecdsa = ellipticcurve.Ecdsa

class Transaction {
	constructor(_from, _to, _amount, _type, _content, _timestamp) {
		this.data = {
			from: _from, // Public key of the sender
			to: _to, // Public key of the receiver
			amount: _amount, // Value in native token
			type: _type, // Type of transaction to correctly handle it
			content: _content, // Hex encoded transaction data
			timestamp: _timestamp, // Timestamp of the transaction
		}
		this.signature = null // Signature of the transaction
	}

	// INFO Method to sign the current data of the transaction
	sign(privateKey) {
		let signature = Ecdsa.sign(JSON.stringify(this.data), privateKey)
		return signature // A signed message as a native Buffer
	}
}

module.exports = Transaction
