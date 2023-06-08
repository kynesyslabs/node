// INFO This module exposes a set of functions that can be used to work on transactions
// NOTE It also exposes methods that will be used to process transactions

var ellipticcurve = require("starkbank-ecdsa")
var Ecdsa = ellipticcurve.Ecdsa
var identity = require("./identity.js")

var methods = {
	sign: sign,
    verify: verify,
	sanityCheck: sanityCheck,
	isCoherent: isCoherent
}

// NOTE All the "tx" parameters are Transaction objects as defined in chain.js
// NOTE privateKey and publicKey are ECDSA keys as specified in identity.js

// INFO Given a transaction, sign it with the private key of the sender
// Returns [success, result]
function sign(tx, privateKey) {
	// Check sanity of the structure of the tx object
	if (!tx.content) {
		return [false, "Missing tx.content"]
	}
	// Sign using identity.generate.ecdsa.sign(tx.content, privateKey)
	let _signature = identity.generate.ecdsa.sign(tx.content, privateKey)
	if (!_signature) {
        return [false, "Failed to sign transaction"]
    }
	return [true, _signature]
}

// INFO Given a signed transaction, verify it against the address of the sender
// Returns [result, message]
function verify(tx) {
	// Check sanity of the structure of the tx object
	if (!tx.content) {
        return [false, "Missing tx.content"]
    }
	if (!tx.signature) {
		return [false, "Missing tx.signature"]
	}
    // verify using identity.generate.ecdsa.verify(tx.content, tx.signature, publicKey)
	let _verified = identity.generate.ecdsa.verify(tx.content, tx.signature, tx.from)
	return [_verified, "Result of verify()"]
}

// INFO Checks the integrity of a transaction
function sanityCheck(tx) {
	let _result = true
	// TODO
	return _result
}

// INFO Checking if the tx is coherent to the current state of the blockchain (and the txs pending before it)
function isCoherent(tx) {
	let _result = true
	// TODO
	return _result
}

module.exports = { methods }
