/* eslint-disable no-unused-vars */
import forge from 'node-forge'
import { Buffer } from 'buffer/'
import required from './utils/required'
import bufferize from './utils/bufferizer'
import * as forge_converter from './utils/forge_converter'
import RSA from './rsa'

// TODO Could this be an universan "Sign in with DEMOS" ? Maybe

// INFO Enabling DEMOS wallet connections in the browser exposing a singleton
// NOTE All the methods below return an array of [boolean, string | any] where any can be the result of the method
class DemosWebAuth {
  static _instance = null
  loggedIn = false
  keypair = null
  stringified_keypair = null

  constructor () {
    this.loggedIn = false
    this.keypair = null
    this.stringified_keypair = null
  }

  /**
	 * Description placeholder
	 * @date 14/9/2023 - 13:52:34
	 *
	 * @static
	 * @returns {DemosWebAuth}
	 */
  static getInstance () {
    if (!this._instance) {
      this._instance = new DemosWebAuth()
    }
    return this._instance
  }

  /**
	 * @description Creates a new wallet
	 * @param {?string} seed
	 * @returns {Promise<[boolean, any]>}
	 */
  async create (seed = null) {
    if (!seed) {
      seed = forge.random.getBytesSync(32)
    }
    console.log('[CREATE WALLET] Creating wallet...')
    console.log('[CREATE WALLET] Seed: ' + seed)
    let result = [true, '']
    try {
      this.keypair = {
        privateKey: null,
        publicKey: null
      }
      this.keypair = forge.pki.ed25519.generateKeyPair({ seed })
      console.log(this.keypair)
      this.loggedIn = true
      console.log('[CREATE WALLET] Keypair created!')
      // Stringify the keypair
      console.log('[CREATE WALLET] Stringifying keypair...')
      this.stringified_keypair = {
        privateKey: forge_converter.forgeToString(this.keypair.privateKey),
        publicKey: forge_converter.forgeToString(this.keypair.publicKey)
      }
      result = [true, this.stringified_keypair]
      console.log(this.stringified_keypair)
    } catch (e) {
      result = [false, '[CREATE WALLET ERROR] ' + e.message]
    }
    return result
  }

  /**
	 * @description Connects a wallet to the Demos chain by generating its keypair
	 * @param {string} privKey
	 * @returns {Promise<[boolean, string]>}
	 **/
  async login (privKey) {
    if (typeof privKey === 'string') {
      console.log('[LOGIN] Converting private key from string...')
      privKey = forge_converter.stringToForge(privKey)
      console.log(privKey)
      console.log('[LOGIN] Private key converted!')
    }
    console.log('[LOGIN WALLET] Logging in...')
    if (!required(privKey, false)) {
      return [false, 'You need to provide a private key!']
    }
    // Serializing the private key as a string

    // console.log("[LOGIN WALLET] Serializing private key...")
    // this.keypair.privateKey = forge_converter.stringToForge(this.stringified_keypair.privateKey)
    // console.log(this.keypair.privateKey)

    this.keypair = {
      privateKey: privKey,
      publicKey: null
    }

    // Logging in avoiding crashes on wrong private keys
    try {
      console.log('[LOGIN WALLET] Deriving public key from private key...')
      this.keypair.publicKey = forge.pki.ed25519.publicKeyFromPrivateKey({ privateKey: privKey })
      this.stringified_keypair = {
        privateKey: forge_converter.forgeToString(this.keypair.privateKey),
        publicKey: forge_converter.forgeToString(this.keypair.publicKey)
      }
      this.loggedIn = true

      return [true, 'Successfully logged in!']
    } catch (e) {
      console.log(e)
      return [false, '[LOGIN ERROR] Cannot derive publicKey!']
    }
  }

  /**
	 * @description Disconnects a wallet from the Demos chain
	 * @returns {Promise<[boolean, string]>}
	 **/
  async logout () {
    if (!required(this.keypair, false)) {
      return [true, 'You are already logged out!']
    }
    this.loggedIn = false
    this.keypair = null
    this.stringified_keypair = null
    return [true, 'Successfully logged out!']
  }

  /**
	 * @description Using our wallet, signs a message
	 * @param {string} message
	 * @returns {Promise<[boolean, string | forge.pki.ed25519.BinaryBuffer]>}
	 **/
  async sign (message) {
    if (!required(this.keypair || this.stringified_keypair, false)) {
      return [false, 'You need to login first!']
    }
    // If needed, we derive the keys from the strings
    if (!this.keypair) {
      console.log('[SIGN WALLET] Deriving buffer keys from strings...')
      this.keypair = {
        privateKey: forge_converter.stringToForge(this.stringified_keypair.privateKey),
        publicKey: forge_converter.stringToForge(this.stringified_keypair.publicKey)
      }
    }
    let result = [true, '']
    try {
      const sign_result = forge.pki.ed25519.sign(message, this.keypair.privateKey)
      result = [true, sign_result]
    } catch (e) {
      result = [false, '[SIGN ERROR] ' + e.message]
    }
    return result // Is already a [boolean, string]
  }

  /**
	 * @description Verifies a signature cryptographically
	 * @param {string} message
	 * @param {string} signature
	 * @param {string} publicKey
	 * @returns {Promise<[boolean, string]>}
	 **/
  async verify (message, s_signature, s_publicKey) {
    let result = [true, '']
    // Deriving the buffers from the strings
    const publicKey = forge_converter.stringToForge(publicKey)
    const signature = forge_converter.stringToForge(signature)
    try {
      const verify_result = forge.pki.ed25519.verify(message, signature, publicKey)
      result = [true, verify_result]
    } catch (e) {
      result = [false, '[VERIFY ERROR] ' + e.message]
    }
    return result // Is already a [boolean, string]
  }

  rsa () {
    return RSA.getInstance()
  }
}

export default DemosWebAuth
