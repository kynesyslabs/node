/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import * as fs from "fs"
import { pki } from "node-forge"
import terminalkit from "terminal-kit"

import * as bip39 from "bip39"
import log from "@/utilities/logger"
import { cryptography } from "../crypto"
import getRemoteIP from "../network/routines/getRemoteIP"
import { getSharedState } from "src/utilities/sharedState"
import { Demos } from "@kynesyslabs/demosdk/websdk"
import {
    Hashing,
    ucrypto,
    uint8ArrayToHex,
} from "@kynesyslabs/demosdk/encryption"
import { wordlist } from "@scure/bip39/wordlists/english"

const term = terminalkit.terminal

export default class Identity {
    public masterSeed: Uint8Array
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

    /**
     * @deprecated Use loadIdentity instead
     */
    async ensureIdentity(): Promise<void> {
        if (fs.existsSync(getSharedState.identityFile)) {
            // Loading the identity
            // TODO Add load with cryptography
            this.ed25519 = await cryptography.load(getSharedState.identityFile)
            term.yellow("Loaded ecdsa identity")
        } else {
            this.ed25519 = cryptography.new()
            // Writing the identity to disk in binary format
            await cryptography.save(this.ed25519, getSharedState.identityFile)
            term.yellow("Generated new identity")
        }
        // Stringifying to hex
        this.ed25519_hex = {
            privateKey: "0x" + this.ed25519.privateKey.toString("hex"),
            publicKey: "0x" + this.ed25519.publicKey.toString("hex"),
        }
        // Setting the ed25519 keypair in shared state
        getSharedState.identity.ed25519 = this.ed25519
        // Deriving the RSA keypair from the ed25519 one
        //  this.rsa = cryptography.rsa.derive()
    }

    async getPublicIP(): Promise<string> {
        this.publicIP = await getRemoteIP()
        return this.publicIP
    }

    getPublicKeyHex(): string | undefined {
        return "0x" + this.ed25519?.publicKey?.toString("hex")
    }

    setPublicPort(port: string): void {
        this.publicPort = port
    }

    getConnectionString(): string {
        return getSharedState.exposedUrl
    }

    // SECTION: unified crypto

    /**
     * Converts a mnemonic to a seed.
     * @param mnemonic - The mnemonic of the wallet
     * @returns A 128 bytes seed
     *
     * NOTE: This intentionally uses the raw mnemonic string instead of
     * bip39.mnemonicToSeedSync() to maintain compatibility with the wallet
     * extension and SDK (demosclass.ts). The SDK's connectWallet function
     * uses the raw mnemonic string when the mnemonic is valid. This ensures
     * the node generates the same public key as the wallet for the same mnemonic.
     */
    async mnemonicToSeed(mnemonic: string) {
        mnemonic = mnemonic.trim()

        if (!bip39.validateMnemonic(mnemonic, wordlist)) {
            log.error("Invalid mnemonic: not a valid BIP39 mnemonic phrase")
            process.exit(1)
        }

        // Use raw mnemonic string to match wallet/SDK derivation
        const hashable = mnemonic
        const seedHash = Hashing.sha3_512(hashable)

        // remove the 0x prefix
        const seedHashHex = uint8ArrayToHex(seedHash).slice(2)
        return new TextEncoder().encode(seedHashHex)
    }

    /**
     * Loads the identity from the identity file.
     * If the identity file does not exist, it creates a new one.
     *
     * @returns The keypair of the configured signing algorithm
     */
    async loadIdentity() {
        const demos = new Demos()

        if (fs.existsSync(getSharedState.identityFile)) {
            const mnemonic = fs.readFileSync(
                getSharedState.identityFile,
                "utf8",
            )
            this.masterSeed = await this.mnemonicToSeed(mnemonic)
        } else {
            // INFO: If the identity file does not exist, create a new one
            const mnemonic = demos.newMnemonic()
            this.masterSeed = await this.mnemonicToSeed(mnemonic)
            await fs.promises.writeFile(getSharedState.identityFile, mnemonic, {
                encoding: "utf8",
            })
        }

        await ucrypto.generateAllIdentities(this.masterSeed)
        return await ucrypto.getIdentity(getSharedState.signingAlgorithm)
    }
}
