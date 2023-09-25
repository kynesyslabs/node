import * as openpgp from "openpgp"
import Chain from "src/libs/blockchain/chain"
import * as forge from "node-forge"

class PGPClass {
    private static instance: PGPClass
    
    keyPair: any

    constructor() {}

    public static getInstance(): PGPClass {
        if (!this.instance) {
            this.instance = new PGPClass()
        }
        return this.instance
    }

    async getPGPKeyServer() {
        return await Chain.read("SELECT * FROM pgp_key_server")
    }

    // INFO Assigning a new PGP key pair to a user represented by their address
    async generateNewPGPKeyPair(address: string,
        privKey: forge.pki.ed25519.BinaryBuffer,
        signedAddress: forge.pki.ed25519.BinaryBuffer) { // TODO Improve security of verification
        // Convert the private key to a hex string
        let privKeyHex = privKey.toString("hex")
        this.keyPair = await openpgp.generateKey({
            type: "rsa", // Type of the key
            rsaBits: 4096, // RSA key size (defaults to 4096 bits)
            userIDs: [{ name: address, email: (address+"@demos.kynesys") }], // you can pass multiple user IDs
            passphrase: privKeyHex, // protects the private key
        })
    }

    // TODO Add import/export of the key and verification of address
    // TODO Add encryption/decryption of messages


}

const PGP = PGPClass.getInstance
export default PGP