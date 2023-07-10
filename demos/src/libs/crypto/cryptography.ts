import forge, { jsbn, pki, random, util } from "node-forge"
import { promises as fs } from "fs"

export default class Cryptography {
    // INFO Generates a new RSA keypair from a given ecdsa private key
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

    static async save(keypair, path: string) {
        const pem = pki.privateKeyToPem(keypair.privateKey)
        await fs.writeFile(path, pem)
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

    static sign(message: string, privateKey: pki.ed25519.BinaryBuffer) {
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
        const verified = pki.ed25519.verify({
            message,
            encoding: "utf8",
            signature,
            publicKey,
        })
        return verified
    }
}
