// INFO This library contains methods to manage, create, certify and verify identities
/* eslint-disable indent */
/* eslint-disable no-unused-vars */
const forge = require("node-forge")
const { Buffer } = require("buffer")
const fs = require("fs")
var rsa = forge.pki.rsa
var ed25519 = forge.pki.ed25519
var ellipticcurve = require("starkbank-ecdsa") // FIXME Is this to change? Probably yes!
var Ecdsa = ellipticcurve.Ecdsa
var PrivateKey = ellipticcurve.PrivateKey

// TODO Replace starkbank-ecdsa with ed25519 (above)

var cryptography = {
    new: function () {
        // TODO Finish conversions
        var seed = forge.random.getBytesSync(32)
        var keys = ed25519.generateKeyPair({ seed: seed })
        let keypair = {
            privateKey: keys.privateKey,
            publicKey: keys.publicKey,
        }
        return keypair
    },
    newFromSeed: function (string_seed) {
        // TODO Finish conversions
        let bufferSeed = new forge.util.ByteBuffer(string_seed, "utf-8")
        var keys = ed25519.generateKeyPair({ seed: bufferSeed })
        let keypair = {
            privateKey: keys.privateKey,
            publicKey: keys.publicKey,
        }
        return keypair
    },
    // Methods
    save: function (keypair, path) {
        fs.writeFileSync(path, JSON.stringify(keypair.privateKey))
    },
    load: function (path) {
        let keypair = {
            privateKey: null,
            publicKey: null,
        }
        console.log("keypair.privateKey")
        keypair.privateKey = Buffer.from(JSON.parse(fs.readFileSync(path)))
        console.log(keypair.privateKey)
        keypair.publicKey = ed25519.publicKeyFromPrivateKey({
            privateKey: keypair.privateKey,
        })
        return keypair
    },
    // TODO Ensure hex/b64 to key type conversion and utilities
    sign: function (message, privateKey) {
        let signature = ed25519.sign({
            message: message,
            encoding: "utf8",
            privateKey: privateKey,
        })
        // REVIEW If the return is ok
        return signature
    },
    verify: function (message, signature, publicKey) {
        var verified = ed25519.verify({
            message: message,
            encoding: "utf8",
            // node.js Buffer, Uint8Array, forge ByteBuffer, or binary string
            signature: signature,
            // node.js Buffer, Uint8Array, forge ByteBuffer, or binary string
            publicKey: publicKey,
        })
        // REVIEW If the return is ok
        return verified
    },
}

// TODO Replace the below methods for ecdsa with crypto when ready
var generate = {
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

function hexToBuffer(hex) {}

module.exports = { cryptography, generate, certify, verify, load }
