/* eslint-disable no-unused-vars */
import forge from "node-forge"
import { Buffer } from "buffer/"
import required from "./utils/required"
import catcher from "./utils/catcher"

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
		let result = catcher(
			this.keypair = forge.pki.ed25519.generateKeyPair({seed: seed})
		)
		if (result[0]) this.loggedIn = true
		return result
	}

	/**
	 * @description Connects a wallet to the Demos chain by generating its keypair
	 * @param {forge.pki.ed25519.BinaryBuffer} privKey
	 * @returns {Promise<[boolean, string]>}
	 **/
	async login (privKey) {
		if (!required(privKey, false)) return [false, "You need to provide a private key!"]
		// Logging in avoiding crashes on wrong private keys
		try {
			this.keypair = {
				privateKey: privKey,
        	    publicKey: forge.pki.ed25519.publicKeyFromPrivateKey(privKey),
			}
			this.loggedIn = true
			return [true, "Successfully logged in!"]
		} catch (e) {
			return [false, e.message]
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
		let result = catcher(
			forge.pki.ed25519.sign(message, this.keypair.privateKey)
		)
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
		let result = catcher(
			forge.pki.ed25519.verify(message, signature, publicKey)
		)
		return result // Is already a [boolean, string]
	}
}

export default DemosWebAuth