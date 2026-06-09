/**
 * Show Public Key Utility
 *
 * Displays the public key associated with the node's identity
 * without starting the node. Uses the new unified crypto system
 * (mnemonic-based identity with ucrypto).
 *
 * Usage:
 *   bun run show:pubkey                 - Display public key to console
 *   bun run show:pubkey -o file         - Output only the key to specified file
 *   bun run show:pubkey -- <identity>   - Read an explicit identity file
 *                                         instead of the configured default
 *   bun run show:pubkey -- --algo falcon - Use another signing algorithm
 */

import * as fs from "fs"
import * as bip39 from "bip39"
import { wordlist } from "@scure/bip39/wordlists/english.js"
import {
    Hashing,
    ucrypto,
    uint8ArrayToHex,
} from "@kynesyslabs/demosdk/encryption"
import { SigningAlgorithm } from "@kynesyslabs/demosdk/types"
import * as dotenv from "dotenv"
import { Config } from "src/config"

dotenv.config()

const DEFAULT_IDENTITY_FILE = Config.getInstance().core.identityFile
const DEFAULT_SIGNING_ALGORITHM: SigningAlgorithm = "ed25519"
const SUPPORTED_ALGORITHMS: SigningAlgorithm[] = ["ed25519", "falcon", "ml-dsa"]

/**
 * Parse command line arguments.
 *   -o <file>        write only the key to <file>
 *   --algo <name>    signing algorithm (ed25519 | falcon | ml-dsa)
 *   <identity-file>  first positional overrides the configured identity file
 */
function parseArgs(): {
    outputFile: string | null
    identityFile: string
    algorithm: SigningAlgorithm
} {
    const args = process.argv.slice(2)
    let outputFile: string | null = null
    let identityFile = DEFAULT_IDENTITY_FILE
    let algorithm: SigningAlgorithm = DEFAULT_SIGNING_ALGORITHM
    let identitySet = false

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        if (arg === "-o") {
            const value = args[i + 1]
            if (!value) {
                console.error("Error: -o requires a file path")
                process.exit(1)
            }
            outputFile = value
            i++
        } else if (arg === "--algo" || arg === "--algorithm") {
            const value = args[i + 1]
            if (!value || !SUPPORTED_ALGORITHMS.includes(value as SigningAlgorithm)) {
                console.error(
                    `Error: ${arg} requires one of: ${SUPPORTED_ALGORITHMS.join(", ")}`,
                )
                process.exit(1)
            }
            algorithm = value as SigningAlgorithm
            i++
        } else if (arg.startsWith("-")) {
            console.error(`Error: unknown flag: ${arg}`)
            process.exit(1)
        } else if (!identitySet) {
            identityFile = arg
            identitySet = true
        } else {
            console.error(`Error: unexpected extra argument: ${arg}`)
            process.exit(1)
        }
    }

    return { outputFile, identityFile, algorithm }
}

/**
 * Converts a mnemonic to a seed.
 * Matches the derivation logic in identity.ts
 */
async function mnemonicToSeed(mnemonic: string): Promise<Uint8Array> {
    mnemonic = mnemonic.trim()

    if (!bip39.validateMnemonic(mnemonic, wordlist)) {
        console.error(
            "Error: Invalid mnemonic - not a valid BIP39 mnemonic phrase",
        )
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
    const { outputFile, identityFile, algorithm } = parseArgs()

    // Check if identity file exists
    if (!fs.existsSync(identityFile)) {
        console.error(`Error: Identity file not found at '${identityFile}'`)
        console.error(
            "Run the node once to generate an identity, or create one manually.",
        )
        process.exit(1)
    }

    // Read the mnemonic from identity file
    const mnemonic = fs.readFileSync(identityFile, "utf8").trim()

    // Check if this looks like a mnemonic (has spaces) vs old hex format
    if (!mnemonic.includes(" ")) {
        console.error(
            "Error: Identity file appears to use old format (hex private key).",
        )
        console.error("The new identity system uses BIP39 mnemonic phrases.")
        console.error(
            "Use 'bun run keygen' for old format, or regenerate identity with new system.",
        )
        process.exit(1)
    }

    // Derive seed from mnemonic
    const masterSeed = await mnemonicToSeed(mnemonic)

    // Generate all identities using ucrypto
    await ucrypto.generateAllIdentities(masterSeed)

    // Get the identity for the selected signing algorithm
    const identity = await ucrypto.getIdentity(algorithm)

    // Get the public key
    const publicKeyHex = uint8ArrayToHex(identity.publicKey as Uint8Array)

    // Output to file if -o flag provided, otherwise display to console
    if (outputFile) {
        await fs.promises.writeFile(outputFile, publicKeyHex, "utf8")
    } else {
        console.log("\n=== Demos Node Public Key ===\n")
        console.log(`Signing Algorithm: ${algorithm}`)
        console.log(`Public Key: ${publicKeyHex}`)
        console.log(`\nIdentity File: ${identityFile}`)
        console.log("\n=============================\n")
    }
}

main().catch(error => {
    console.error("Error:", error.message)
    process.exit(1)
})
