// NOTE This is the Enigma PQC library. It will supersede the existing PQC library located in 'features'
import { superDilithium } from "superdilithium"

export default class Enigma {

    private keyPair: {privateKey: Uint8Array; publicKey: Uint8Array}

    constructor() {
    }

    // Generate a new key pair or import an existing one
    async init(privateKey?: Uint8Array) {
        if (!privateKey) {
            this.keyPair = await superDilithium.keyPair()
        } else {
            this.keyPair = await superDilithium.importKeys({
                private: {
                    combined: privateKey.toString(),
                },
            })
        }
    }

    // Sign a message supporting string or byte array
    async sign(message: string | Uint8Array) {
        return await superDilithium.sign(message, this.keyPair.privateKey)
    }

    // Verify a detached signature supporting string or byte array
    async verify(signature: string | Uint8Array, message: string | Uint8Array, publicKey: string | Uint8Array) {
        if (typeof publicKey === "string") {
            publicKey = new Uint8Array(publicKey.split(",").map(Number))
        }
        return await superDilithium.verifyDetached(signature, message, publicKey)
    }
  
    // Export the key pair
    async exportKeys(passphrase: string) {
        return await superDilithium.exportKeys(this.keyPair, passphrase)
    }
}

async function main() {
    const enigma = new Enigma()
    await enigma.init()
    const keys = await enigma.exportKeys("password")
    console.log(keys)
}

main()
