/**
 * Show Public Key Utility
 *
 * Displays the public key associated with the node's identity
 * without starting the node. Uses the new unified crypto system
 * (mnemonic-based identity with ucrypto).
 *
 * Usage:
 *   bun run show:pubkey           - Display public key to console
 *   bun run show:pubkey -o file   - Output only the key to specified file
 */

import * as fs from "fs"
import * as bip39 from "bip39"
import { wordlist } from "@scure/bip39/wordlists/english"
import { Hashing, ucrypto, uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import { SigningAlgorithm } from "@kynesyslabs/demosdk/types"
import * as dotenv from "dotenv"

dotenv.config()

const IDENTITY_FILE = process.env.IDENTITY_FILE || ".demos_identity"
const SIGNING_ALGORITHM: SigningAlgorithm = "ed25519"

/**
 * Parse command line arguments for -o flag
 */
function parseArgs(): { outputFile: string | null } {
    const args = process.argv.slice(2)
    const outputIndex = args.indexOf("-o")

    if (outputIndex !== -1 && args[outputIndex + 1]) {
        return { outputFile: args[outputIndex + 1] }
    }

    return { outputFile: null }
}

/**
 * Converts a mnemonic to a seed.
 * Matches the derivation logic in identity.ts
 */
async function mnemonicToSeed(mnemonic: string): Promise<Uint8Array> {
    mnemonic = mnemonic.trim()

    if (!bip39.validateMnemonic(mnemonic, wordlist)) {
        console.error("Error: Invalid mnemonic - not a valid BIP39 mnemonic phrase")
        process.exit(1)
    }

    // Use raw mnemonic string to match wallet/SDK derivation
    const hashable = mnemonic
    const seedHash = Hashing.sha3_512(hashable)

    // Remove the 0x prefix
    const seedHashHex = uint8ArrayToHex(seedHash).slice(2)
    return new TextEncoder().encode(seedHashHex)
}

async function main() {
    const { outputFile } = parseArgs()

    // Check if identity file exists
    if (!fs.existsSync(IDENTITY_FILE)) {
        console.error(`Error: Identity file not found at '${IDENTITY_FILE}'`)
        console.error("Run the node once to generate an identity, or create one manually.")
        process.exit(1)
    }

    // Read the mnemonic from identity file
    const mnemonic = fs.readFileSync(IDENTITY_FILE, "utf8").trim()

    // Check if this looks like a mnemonic (has spaces) vs old hex format
    if (!mnemonic.includes(" ")) {
        console.error("Error: Identity file appears to use old format (hex private key).")
        console.error("The new identity system uses BIP39 mnemonic phrases.")
        console.error("Use 'bun run keygen' for old format, or regenerate identity with new system.")
        process.exit(1)
    }

    // Derive seed from mnemonic
    const masterSeed = await mnemonicToSeed(mnemonic)

    // Generate all identities using ucrypto
    await ucrypto.generateAllIdentities(masterSeed)

    // Get the identity for the configured signing algorithm
    const identity = await ucrypto.getIdentity(SIGNING_ALGORITHM)

    // Get the public key
    const publicKeyHex = uint8ArrayToHex(identity.publicKey)

    // Output to file if -o flag provided, otherwise display to console
    if (outputFile) {
        await fs.promises.writeFile(outputFile, publicKeyHex, "utf8")
    } else {
        console.log("\n=== Demos Node Public Key ===\n")
        console.log(`Signing Algorithm: ${SIGNING_ALGORITHM}`)
        console.log(`Public Key: ${publicKeyHex}`)
        console.log(`\nIdentity File: ${IDENTITY_FILE}`)
        console.log("\n=============================\n")
    }
}

main().catch((error) => {
    console.error("Error:", error.message)
    process.exit(1)
})
