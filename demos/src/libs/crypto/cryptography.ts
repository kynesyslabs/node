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
const ed25519 = forge.pki.ed25519

export default class Cryptography {
    // TODO Generates a new RSA keypair from a given ecdsa private key
    static new() {
        const seed = random.getBytesSync(32)
        const keys = pki.ed25519.generateKeyPair({ seed })
        console.log("Generated new keypair")
        return keys
    }

    // INFO Method to generate a new key pair from a seed
    static newFromSeed(stringSeed: string) {
        const keys = pki.ed25519.generateKeyPair({ seed: stringSeed })
        return keys
    }


    static async save(keypair: pki.KeyPair, path: string) {
        console.log(keypair.privateKey)
        await fs.writeFile(path, JSON.stringify(keypair.privateKey))

    }

    static async load(path) {
        let keypair: pki.KeyPair = {
            privateKey: null,
            publicKey: null,
        }

        const pem = await fs.readFile(path, "utf8")
        keypair.privateKey = Buffer.from(JSON.parse(pem))
        keypair.publicKey = pki.ed25519.publicKeyFromPrivateKey({
            privateKey: keypair.privateKey,
        })
        return keypair
    }

    static sign(message: string, privateKey: pki.ed25519.BinaryBuffer | any) {
        const signature = pki.ed25519.sign({
            message,
            encoding: "utf8",
            privateKey,
        })
        return signature
    }

    // FIXME Is not working at the moment (in tx from the websdk gives a mismatch?)
    /*
ONLY if sent by web tho (prolly a matter of buffers of course)
[COMLINK VALIDATION ERROR] (on validateComlink) TypeError: "options.message" must be a node.js Buffer, a Uint8Array, a forge ByteBuffer, or a string with "options.encoding" specifying its encoding.
    */
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
        const verified = ed25519.verify({
            message: signed,
            encoding: "utf8",
            signature: signature,
            // eslint-disable-next-line comma-dangle
            publicKey: publicKey
        })
        return verified
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
        encrypt: (message: string, publicKey: pki.rsa.PublicKey): string => {
            let based = forge.util.encode64(message)
            const encrypted = publicKey.encrypt(based)
            return encrypted
        },

        // INFO Decryption method using the private key
        decrypt: (message: string, privateKey: pki.rsa.PrivateKey = null) => {
            // NOTE If no private key is provided, we try to use our one
            if (!privateKey) {
                privateKey = Identity.getInstance().rsa.privateKey
                if (!privateKey) {
                    return [false, "No private key found"]
                }
            }
            let debased = forge.util.decode64(message)
            const decrypted = privateKey.decrypt(debased)
            return decrypted
        },
    }

}
