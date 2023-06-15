/* eslint-disable indent */
/* eslint-disable no-unused-vars */
const forge = require("node-forge")
const { Buffer } = require("buffer")
const fs = require("fs")
var rsa = forge.pki.rsa
var ellipticcurve = require("starkbank-ecdsa")
var Ecdsa = ellipticcurve.Ecdsa
var PrivateKey = ellipticcurve.PrivateKey


// REVIEW Experimental air module
var air = require("./classes/air")
var imc = new air()
imc.initialize("identity")

// INFO This library contains methods to manage, create, certify and verify identities

var generate = {
	// NOTE ecdsa is the algorithm used for wallets and transactions
	ecdsa: {
		// INFO Generates a new RSA keypair from random 32 bytes seed
		new: async function () {
			// Generate new Keys
			let privateKey = new PrivateKey()
			let publicKey = privateKey.publicKey()
			let keypair = {
				privateKey: privateKey,
				privateKeyPEM: privateKey.toPem(),
				privateKeyHex: stringToHex(privateKey.toPem()),
				publicKey: publicKey,
				publicKeyPEM: publicKey.toPem(),
				publicKeyHex: stringToHex(publicKey.toPem()).replace("2d2d2d2d2d424547494e205055424c4943204b45592d2d2d2d2d", "").replace("2d2d2d2d2d454e44205055424c4943204b45592d2d2d2d2d0a", ""),
			}
			return keypair
		},
		// INFO Generates a new RSA keypair from a given seed
		newFromSeed: async function (string_seed) {
			let privateKey = PrivateKey.fromString(string_seed)
			let publicKey = privateKey.publicKey()
			let keypair = {
				privateKey: privateKey,
				privateKeyPEM: privateKey.toPem(),
				privateKeyHex: stringToHex(privateKey.toPem()),
				publicKey: publicKey,
				publicKeyPEM: publicKey.toPem(),
				publicKeyHex: stringToHex(publicKey.toPem()).replace("2d2d2d2d2d424547494e205055424c4943204b45592d2d2d2d2d", "").replace("2d2d2d2d2d454e44205055424c4943204b45592d2d2d2d2d0a", ""),
			}
			return keypair
		},
		// INFO signing method
		sign: async function (message, privateKey) {
			let signature = Ecdsa.sign(message, privateKey)
			return signature // A signed message as a native Buffer
		},
		// INFO verifying method
		verify: async function (message, signature, publicKey) {
			var verified = Ecdsa.verify(message, signature, publicKey)
			return verified // true or false compared to the publicKey provided
		},
	},
	// NOTE RSA is the algorithm used for identities verifications
	rsa: {
		// INFO Generates a new RSA keypair from a given ecdsa private key
		new: async function (ecdsa_private_key) {
			const md = forge.md.sha256.create()
			md.update(ecdsa_private_key)
			const seed = md.digest().toHex()
			const prng = forge.random.createInstance()
			prng.seedFileSync = () => seed
			// Deterministic key generation
			const keypair = rsa.generateKeyPair({
				bits: 4096,
				prng,
			})
			return keypair
		},
		// INFO signing method
		sign: async function (message, privateKey) {
			const md = forge.md.sha256.create()
			md.update(message)
			const signature = privateKey.sign(md)
			return signature
		},
		// INFO verifying method
		verify: async function (message, signature, publicKey) {
			const md = forge.md.sha256.create()
			md.update(message)
			const verified = publicKey.verify(md.digest().bytes(), signature)
			return verified
		},
		// INFO encrypting method
		encrypt: async function (message, publicKey) {
			const encrypted = publicKey.encrypt(message)
			return encrypted
		},
		// INFO decrypting method
		decrypt: async function (message, privateKey) {
			const decrypted = privateKey.decrypt(message)
			return decrypted
		},
	},
}

var load = {
	// INFO Loads an identity from a given ecdsa private key
	fromFile: async function (path) {
		let _privateKey = fs.readFileSync(path, "utf8")
		return await this.fromPrivateKey(_privateKey)
	},
	// Recovering a keypair from the private key
	fromPrivateKey: async function (privateKeyPEM) {
		let privateKey = PrivateKey.fromPem(privateKeyPEM)
		let publicKey = privateKey.publicKey()
		let keypair = {
			privateKey: privateKey,
			privateKeyPEM: privateKey.toPem(),
			privateKeyHex: stringToHex(privateKey.toPem()),
			publicKey: publicKey,
			publicKeyPEM: publicKey.toPem(),
			publicKeyHex: stringToHex(publicKey.toPem()),
		}
		return keypair
	},
}

var certify = {}

var verify = {}

function stringToHex(str) {
	//converting string into buffer
	let bufStr = Buffer.from(str, "utf8")

	//with buffer, you can convert it into hex with following code
	return bufStr.toString("hex")
}

module.exports = { generate, certify, verify, load, imc }
