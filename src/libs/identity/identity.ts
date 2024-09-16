/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import * as fs from "fs"
import { pki } from "node-forge"
import terminalkit from "terminal-kit"

import { cryptography } from "../crypto"
import getRemoteIP from "../network/routines/getRemoteIP"
import sharedState from "src/utilities/sharedState"

const term = terminalkit.terminal

export default class Identity {
    private static instance: Identity
    public ed25519: pki.KeyPair
    public ed25519_hex: {
        privateKey: string
        publicKey: string
    }
    public rsa: pki.rsa.KeyPair
    public rsa_hex: {
        privateKey: string
        publicKey: string
    }
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
        if (fs.existsSync(sharedState.getInstance().identityFile)) {
            // Loading the identity
            // TODO Add load with cryptography
            this.ed25519 = await cryptography.load(sharedState.getInstance().identityFile)
            term.yellow("Loaded ecdsa identity")
        } else {
            this.ed25519 = cryptography.new()
            // Writing the identity to disk in binary format
            await cryptography.save(this.ed25519, sharedState.getInstance().identityFile)
            term.yellow("Generated new identity")
        }
        // Stringifying to hex
        this.ed25519_hex = {
            privateKey: "0x" + this.ed25519.privateKey.toString("hex"),
            publicKey: "0x" + this.ed25519.publicKey.toString("hex"),
        }
        // Setting the ed25519 keypair in shared state
        sharedState.getInstance().identity.ed25519 = this.ed25519
        // Deriving the RSA keypair from the ed25519 one
        //  this.rsa = cryptography.rsa.derive()
    }

    async getPublicIP(): Promise<string> {
        this.publicIP = await getRemoteIP()
        return await this.publicIP
    }

    getPublicKeyHex(): string | undefined {
        return "0x" + this.ed25519?.publicKey?.toString("hex")
    }

    setPublicPort(port: string): void {
        this.publicPort = port
    }

    getConnectionString(): string {
        return sharedState.getInstance().exposedUrl
    }
}
