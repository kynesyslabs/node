// INFO This library contains methods to manage, create, certify and verify identities
/* eslint-disable indent */
/* eslint-disable no-unused-vars */
const forge = require("node-forge")
const { Buffer } = require("buffer")
const fs = require("fs")
var rsa = forge.pki.rsa
var ellipticcurve = require("starkbank-ecdsa") // FIXME Is this to change? Probably yes!
var Ecdsa = ellipticcurve.Ecdsa
var PrivateKey = ellipticcurve.PrivateKey

// TODO Replace starkbank-ecdsa with ed25519 or crypto
const crypto = require("crypto")
var hash_type = "sha256"
var curve_type = "secp256k1"

var cryptography = {
    new: function () {
        let {privateKey, publicKey} = crypto.generateKeyPairSync("ec", {
            namedCurve: curve_type,
            publicKeyEncoding: { type: "spki", format: "pem" },
            privateKeyEncoding: { type: "pkcs8", format: "pem" },
        })
        let keypair = {
            privateKey: privateKey,
            privateKeyB64: privateKey.toString("base64"),
            privateKeyHex: stringToHex(privateKey.toString("base64")),
            publicKey: publicKey,
            publicKeyB64: publicKey.toString("base64"),
            publicKeyHex: stringToHex(publicKey.toString("base64")),
        }
        return keypair
    },
    newFromSeed: function (string_seed) {
        // TODO 
    },
    // TODO Ensure hex/b64 to key type conversion and utilities
    sign: function (message, privateKey) {
        let sign = crypto.createSign(hash_type)
        sign.write(message)
        sign.end()
        var signature = sign.sign(privateKey, "hex")
        return signature
    },
    verify: function (message, signature, publicKey) {
        let verify = crypto.createVerify(hash_type)
        verify.write(message)
        verify.end()
        let verified = verify.verify(publicKey, signature, "hex")
        return verified
    },
}

// TODO Replace the below methods for ecdsa with crypto when ready
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
                publicKeyHex: stringToHex(publicKey.toPem()),
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
                publicKeyHex: stringToHex(publicKey.toPem()),
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
        // INFO Hex to PublicKey
        ingestHex: function (hex_public) {
            let pem_public = hexToString(hex_public) // FIXME Decode it
            console.log("[DECODED] Public Key to PEM")
            return ellipticcurve.PublicKey.fromPem(pem_public)
        },
        ingestPEM: function (pem_public) {
            return ellipticcurve.PublicKey.fromPem(pem_public)
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

function hexToString(hex) {
    let bufStr = Buffer.from(hex, "hex")
    return bufStr.toString("utf-8")
}

module.exports = { generate, certify, verify, load }
