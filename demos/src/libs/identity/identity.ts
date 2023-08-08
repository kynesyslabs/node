/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import * as fs from "fs"
import { cryptography } from "../crypto"
import Logger from "../utils/logger"
import { pki } from "node-forge"
import getRemoteIP from "../network/routines/getRemoteIP"

export default class Identity {
    private static instance: Identity
    public ed25519: pki.KeyPair
    public publicIP: string
    public publicPort: string

    // Make the constructor private.
    private constructor() {
        this.ed25519 = null
        this.publicIP = null
        this.publicPort = null
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
            await cryptography.save(this.ed25519, "./.demos_identity")
            Logger.log("Generated new identity")
        }
    }

    async getPublicIP(): Promise<string> {
        this.publicIP = await getRemoteIP()
        return await this.publicIP
    }

    getPublicKeyHex(): string | undefined {
        return this.ed25519?.publicKey?.toString("hex")
    }

    setPublicPort(port: string): void {
        this.publicPort = port
    }

    getConnectionString(): string {
        return `http://${this.publicIP}>${
            this.publicPort
        }>${this.getPublicKeyHex()}`
    }
}
