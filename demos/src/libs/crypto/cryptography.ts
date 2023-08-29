/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { pki, random } from "node-forge"
import * as forge from "node-forge"
import { promises as fs } from "fs"
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

    static async saveRSA(keypair: pki.KeyPair, path: string) {
        console.log(keypair.privateKey)
        const pem = pki.privateKeyToPem(keypair.privateKey)
        await fs.writeFile(path, pem)
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

    static verify( 
        signed: string,
        signature: string | pki.ed25519.BinaryBuffer,
        publicKey: string | pki.ed25519.BinaryBuffer,
    ) {
        if (typeof(publicKey)==="string") {
            publicKey = Buffer.from(publicKey, "hex")
            console.log("[*] String public key detected: buffering it")
        }
        if (typeof(signature)==="string") {
            signature = Buffer.from(signature, "hex")
            console.log("[*] String signature detected: buffering it")
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
        const verified = ed25519.verify({
            message: Buffer.from(signed, "utf8"),
            encoding: "utf8",
            publicKey: publicKey,
            signature: signature,
        })
        return verified
    }

    // ANCHOR Encryption part

    static async encrypt(message: any, rsa_public_key: pki.rsa.PublicKey): Promise<any> {
        // TODO
    }

    static async decrypt(message: any, rsa_private_key: pki.rsa.PrivateKey): Promise<any> {
        // TODO
    }
}
