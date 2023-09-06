/* eslint-disable no-unused-vars */
import forge from "node-forge"
import { Buffer } from "buffer/"
import required from "./utils/required"
import bufferize from "./utils/bufferizer"
import * as forge_converter from "./utils/forge_converter"

// TODO Could this be an universan "Sign in with DEMOS" ? Maybe

// INFO Enabling DEMOS wallet connections in the browser exposing a singleton
// NOTE All the methods below return an array of [boolean, string | any] where any can be the result of the method
class DemosWebAuth {
	static _instance = null
	loggedIn = false
	keypair = null

	constructor() {}

	static getInstance() {
        if (!this._instance) this._instance = new this()
        return this._instance
    }

	/**
	 * @description Creates a new wallet
	 * @param {?string} seed
	 * @returns {Promise<[boolean, string]>}
	 */
	async create (seed=null) {
		if (!seed) seed = forge.random.getBytesSync(32)
		console.log("[CREATE WALLET] Creating wallet...")
		console.log("[CREATE WALLET] Seed: " + seed)
		let result = [true, ""]
		try {
		    this.keypair = {
				privateKey: null,
				publicKey: null,
			}
			this.keypair =  forge.pki.ed25519.generateKeyPair({seed: seed})
			console.log(this.keypair)
			this.loggedIn = true
			result = [true, this.keypair]
			console.log("[CREATE WALLET] Keypair created!")
		} catch (e) {
			result = [false, "[CREATE WALLET ERROR] " + e.message]
        }
		return result
	}

	/**
	 * @description Connects a wallet to the Demos chain by generating its keypair
	 * @param {forge.pki.ed25519.BinaryBuffer} privKey
	 * @returns {Promise<[boolean, string]>}
	 **/
	async login (privKey) {
		console.log("[LOGIN WALLET] Logging in...")
		if (!required(privKey, false)) return [false, "You need to provide a private key!"]
		// Logging in avoiding crashes on wrong private keys
		try {
			//privKey = bufferize(privKey)
			console.log(privKey)
			console.log(typeof(privKey))
			console.log("[LOGIN WALLET] Deriving public key from private key...")
			this.keypair = {
				privateKey: privKey,
				// NOTE in general avoid not named arguments, always use {arg: value} syntax
        	    publicKey: forge.pki.ed25519.publicKeyFromPrivateKey({privateKey: privKey}),
			}
			this.loggedIn = true
			return [true, "Successfully logged in!"]
		} catch (e) {
			console.log(e)
			return [false, "[LOGIN ERROR] Cannot derive publicKey!"]
        }
	}

	/**
	 * @description Disconnects a wallet from the Demos chain
     * @returns {Promise<[boolean, string]>}
     **/
	async logout () {
		if (!required(this.keypair, false)) return [true, "You are already logged out!"]
		this.loggedIn = false
		this.keypair = null
		return [true, "Successfully logged out!"]
	}

	/**
	 * @description Using our wallet, signs a message
	 * @param {string} message
     * @returns {Promise<[boolean, string | forge.pki.ed25519.BinaryBuffer]>}
     **/
	async sign (message) {
		if (!required(this.keypair, false)) return [false, "You need to login first!"]
		let result = [true, ""]
		try {
			let sign_result = forge.pki.ed25519.sign(message, this.keypair.privateKey)
			result = [true, sign_result]
		} catch (e) {
			result = [false, "[SIGN ERROR] " + e.message]
		}
		return result // Is already a [boolean, string]
	}

	/**
	 * @description Verifies a signature cryptographically
	 * @param {string} message
	 * @param {forge.pki.ed25519.BinaryBuffer} signature
	 * @param {forge.pki.ed25519.BinaryBuffer} publicKey
     * @returns {Promise<[boolean, string]>}
     **/
	async verify (message, signature, publicKey) {
		let result = [true, ""]
		try {
			let verify_result = forge.pki.ed25519.verify(message, signature, publicKey)
			result = [true, verify_result]
		} catch (e) {
			result = [false, "[VERIFY ERROR] " + e.message]
		}
		return result // Is already a [boolean, string]
	}
}

export default DemosWebAuth