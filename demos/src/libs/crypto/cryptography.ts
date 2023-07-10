import forge, { pki, random } from "node-forge"
import { promises as fs } from "fs"

export default class Cryptography {
    // INFO Generates a new RSA keypair from a given ecdsa private key
    static new() {
        const seed = random.getBytesSync(32)
        const keys = pki.ed25519.generateKeyPair({ seed })
        return keys
    }

    // INFO Method to generate a new key pair from a seed
    static newFromSeed(stringSeed: string) {
        const bufferSeed = new forge.util.ByteBuffer(stringSeed, "utf-8")
        const keys = pki.ed25519.generateKeyPair({ seed: bufferSeed })
        return keys
    }

    static async save(keypair: pki.ed25519.KeyPair, path: string) {
        await fs.writeFile(path, JSON.stringify(keypair.privateKey))
    }

    static async load(path: string) {
        const keypair: pki.ed25519.KeyPair = {
            privateKey: null,
            publicKey: null,
        }
        console.log("Loading keypair from " + path)
        const loadedData = await fs.readFile(path, "utf8")
        keypair.privateKey = JSON.parse(loadedData.toString())
        console.log("Loaded keypair from " + path)
        console.log(keypair)
        keypair.publicKey = pki.ed25519.publicKeyFromPrivateKey({
            privateKey: keypair.privateKey,
        })
        return keypair
    }

    static sign(message: string, privateKey: forge.pki.ed25519.PrivateKey) {
        const signature = pki.ed25519.sign({
            message,
            encoding: "utf8",
            privateKey,
        })
        return signature
    }

    static verify(
        message: string,
        signature: forge.pki.ed25519.Signature,
        publicKey: forge.pki.ed25519.PublicKey,
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
