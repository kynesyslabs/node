import * as fs from "fs"
import { cryptography } from "../crypto"
import Logger from "../utils/logger"
import { pki } from "node-forge"


export default class Identity {
    private static instance: Identity
    public ed25519: pki.KeyPair

    // Make the constructor private.
    private constructor() {
        this.ed25519 = null
    }

    // Create a public static method to get the instance of the Identity class
    public static getInstance(): Identity {
        if (!Identity.instance) {
            Identity.instance = new Identity()
        }
        return Identity.instance
    }

    async ensureIdentity(): Promise<void> {
        if (fs.existsSync("./.demos_identity")) {
            // Loading the identity
            this.ed25519 = await cryptography.load("./.demos_identity") // TODO Add load with cryptography
            Logger.log("Loaded ecdsa identity")
        } else {
            this.ed25519 = await cryptography.new()
            // Writing the identity to disk in binary format
            cryptography.save(this.ed25519, "./.demos_identity")
            Logger.log("Generated new identity")
        }
    }

    getPublicKeyHex(): string | undefined {
        return this.ed25519?.publicKey?.toString("hex")
    }
}
