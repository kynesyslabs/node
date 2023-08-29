/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import forge, { jsbn, pki, random, util } from "node-forge"
import { promises as fs } from "fs"

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
        message: string,
        signature: pki.ed25519.BinaryBuffer,
        publicKey: pki.ed25519.BinaryBuffer,
    ) {
        console.log(message + " is a " + typeof(message))
        console.log(signature + " is a " + typeof(signature))
        console.log(publicKey + " is a " + typeof(publicKey))
        const verified = pki.ed25519.verify({
            message: message,
            encoding: "utf8",
            signature: signature,
            publicKey: publicKey,
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
