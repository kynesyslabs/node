/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { pki, random } from "node-forge"
import * as forge from "node-forge"
import { promises as fs } from "fs"
import { Identity } from "../identity"
const term = require("terminal-kit")
const {ed25519} = forge.pki
const crypto = require("crypto")
const algorithm = "aes-256-cbc"

export default class Cryptography {
    
    static new() {
        const seed = random.getBytesSync(32)
        const keys = pki.ed25519.generateKeyPair({ seed })
        console.log("Generated new keypair")
        return keys
    }

    // INFO Method to generate a new key pair from a seed
    static newFromSeed(stringSeed: string) {
        return pki.ed25519.generateKeyPair({ seed: stringSeed })
    }

    // TODO Eliminate the old legacy compatibility
    static async save(keypair: pki.KeyPair, path: string, mode="hex") {
        console.log(keypair.privateKey)
        if (mode === "hex") {
            let hexPrivKey = Cryptography.saveToHex(keypair.privateKey)
            await fs.writeFile(path, hexPrivKey)
        } else {
            await fs.writeFile(path, JSON.stringify(keypair.privateKey))
        }
    }

    static saveToHex(forgeBuffer: pki.PrivateKey): string {
        console.log("[forge to string encoded]")
        console.log(forgeBuffer) // REVIEW if it is like this
        let stringBuffer = forgeBuffer.toString("hex")
        console.log("DECODED INTO:")
        console.log("0x" + stringBuffer)
        return "0x" + stringBuffer
    }

    // SECTION Encrypted save and load
    static async saveEncrypted(
        keypair: pki.KeyPair,
        path: string,
        password: string) {
        const key = crypto.createCipher(algorithm, password)
        // Getting the private key in hex form
        const hex_key = keypair.privateKey.toString("hex")
        // Encrypting and saving
        const encryptedMessage = key.update(hex_key, "utf8", "hex")
        await fs.writeFile(path, encryptedMessage)
    }

    static async loadEncrypted(
        path: string,
        password: string) {
        let keypair: pki.KeyPair = {
            privateKey: null,
            publicKey: null,
        }
        // Preparing the environment
        const decipher = crypto.createDecipher(algorithm, password)
        const contentOfFile = await fs.readFile(path, "utf8")
        // Decrypting
        const decryptedKey = decipher.update(contentOfFile, "hex", "utf8")
        // Loading
        if (decryptedKey.includes("{")) {
            keypair = Cryptography.loadFromBufferString (contentOfFile)
        } else {
            keypair = Cryptography.loadFromHex(contentOfFile)
        }
        return keypair
    }
    // !SECTION Encrypted save and load


    static async load(path) {
        let keypair: pki.KeyPair = {
            privateKey: null,
            publicKey: null,
        }

        const contentOfFile = await fs.readFile(path, "utf8")
        if (contentOfFile.includes("{")) {
            keypair = Cryptography.loadFromBufferString (contentOfFile)
        } else {
            keypair = Cryptography.loadFromHex(contentOfFile)
        }
        return keypair
    }

    static loadFromHex(content: string): pki.KeyPair {
        let keypair = { publicKey: null, privateKey: null }
        content = content.slice(2)
        let finalArray = new Uint8Array(64)
        console.log("[string to forge encoded]")
        console.log(content)
        for (let i = 0; i < content.length; i += 2) {
            const hexValue = content.substr(i, 2)
            const decimalValue = parseInt(hexValue, 16)
            finalArray[i / 2] = decimalValue
        }
        console.log("ENCODED INTO:")
        console.log(finalArray)
        // Condensing
        console.log("That means:")
        keypair.privateKey = Buffer.from(finalArray)
        console.log(keypair.privateKey)
        console.log("And the public key is:")
        keypair.publicKey = ed25519.publicKeyFromPrivateKey({privateKey: keypair.privateKey})
        console.log(keypair.publicKey)
        return keypair
    }

    static loadFromBufferString(content: string): pki.KeyPair {
        let keypair = { publicKey: null, privateKey: null }
        keypair.privateKey = Buffer.from(JSON.parse(content))
        keypair.publicKey = pki.ed25519.publicKeyFromPrivateKey({
            privateKey: keypair.privateKey,
        })
        return keypair
    }

    static sign(message: string, privateKey: pki.ed25519.BinaryBuffer | any) {
        return pki.ed25519.sign({
            message,
            encoding: "utf8",
            privateKey,
        })
    }

    static verify( 
        signed: string,
        signature: any | pki.ed25519.BinaryBuffer,
        publicKey: any | pki.ed25519.BinaryBuffer,
    ) {
        // REVIEW
        if(signature.type=="Buffer") {
            console.log("Normalizing signature...")
            signature = Buffer.from(signature)
        }
        if(publicKey.type=="Buffer") {
            console.log("Normalizing publicKey...")
            publicKey = Buffer.from(publicKey)
        }

        console.log("\n\nSigned: \n")
        console.log(signed + " is a " + typeof(signed))
        console.log("\n\nSignature: \n")
        console.log(signature)
        console.log(" is a " + typeof(signature))
        console.log("\n\nPublic Key:\n")
        console.log(publicKey)
        console.log(" is a " + typeof(publicKey))
        console.log("\n")
        console.log("[*] Verifying the signature...")
        return ed25519.verify({
            message: signed,
            encoding: "utf8",
            signature: signature,
            // eslint-disable-next-line comma-dangle
            publicKey: publicKey
        })
    }

    // ANCHOR Encryption part
    static rsa = {

        // INFO Generating a new RSA keypair from our ecdsa private key
        derive: (): forge.pki.rsa.KeyPair => {
            let md = forge.md.sha256.create()
            md.update(JSON.stringify(Identity.getInstance().ed25519.privateKey))
            let seed = md.digest().toHex()
            let pnrg = forge.random.createInstance()
            pnrg.seedFileSync = () => seed
            let keys = forge.pki.rsa.generateKeyPair({ bits: 4096, prng: pnrg })
            Identity.getInstance().rsa = keys
            return keys
        },

        // INFO Encryption method using the public key
        encrypt: (message: string, publicKey: any | pki.rsa.PublicKey): [boolean, any] => {
            // NOTE Supporting "fake buffers" from web browsers
            if(publicKey.type=="Buffer") {
                console.log("[ENCRYPTION] Normalizing publicKey...")
                publicKey = Buffer.from(publicKey)
            }
            // Converting the message and decrypting it
            let based = forge.util.encode64(message)
            const encrypted = publicKey.encrypt(based)
            return [true, encrypted]
        },

        // INFO Decryption method using the private key
        decrypt: (message: string, privateKey: any | pki.rsa.PrivateKey = null): [boolean, any] => {
            // NOTE Supporting "fake buffers" from web browsers
            try {
                if(privateKey.type=="Buffer") {
                    term.yellow("[DECRYPTION] Normalizing privateKey...\n")
                    privateKey = Buffer.from(privateKey)
                }
            }
            catch (e) {
                term.yellow("[DECRYPTION] Looks like there is nothing to normalize here, let's proceed\n")
                console.log(e)
            }
            // Converting back the message and decrypting it
            // NOTE If no private key is provided, we try to use our one
            if (!privateKey) {
                term.yellow("[DECRYPTION] No private key provided, using our one...\n")
                privateKey = Identity.getInstance().rsa.privateKey
                if (!privateKey) {
                    term.red("[DECRYPTION] No private key found\n")
                    return [false, "No private key found"]
                }
            }
            let debased = forge.util.decode64(message)
            const decrypted = privateKey.decrypt(debased)
            return [true, decrypted.toString()]
        },
    }

}
