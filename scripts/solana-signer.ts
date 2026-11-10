// Loads a Solana signing key from a file in any of the formats operators
// commonly hold: a solana-keygen JSON byte array, a base58 private key as
// exported by Phantom or Solflare, or a BIP-39 mnemonic.
import { readFileSync } from "node:fs"

import { Keypair } from "@solana/web3.js"
import * as bip39 from "bip39"
import bs58 from "bs58"
import { derivePath } from "ed25519-hd-key"

export type SolanaSecretKind = "json-array" | "base58" | "mnemonic"

export interface SolanaSigner {
    keypair: Keypair
    kind: SolanaSecretKind
    /** Derivation path used; only set for a mnemonic. */
    derivationPath?: string
}

export interface SolanaSignerOptions {
    /** Account index in the Solana derivation path m/44'/501'/<account>'/0'. */
    account?: number
    /** Optional BIP-39 passphrase (the "25th word"). */
    passphrase?: string
}

export const ACCEPTED_SECRET_FORMATS =
    "a solana-keygen JSON byte array, a base58 private key, or a 12/24-word mnemonic"

const MNEMONIC_WORD_COUNTS = new Set([12, 15, 18, 21, 24])
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/

export function solanaDerivationPath(account: number): string {
    return `m/44'/501'/${account}'/0'`
}

function fromBytes(bytes: Uint8Array, what: string): Keypair {
    if (bytes.length === 64) return Keypair.fromSecretKey(bytes)
    if (bytes.length === 32) return Keypair.fromSeed(bytes)
    throw new Error(`${what} must hold 64 bytes (secret key) or 32 bytes (seed), got ${bytes.length}`)
}

function checkAccount(account: number): void {
    if (!Number.isInteger(account) || account < 0 || account > 0x7fffffff) {
        throw new Error(`account index must be a non-negative integer, got ${account}`)
    }
}

/** Parses the text of a key file. The format is detected from its shape. */
export function parseSolanaSecret(
    text: string,
    options: SolanaSignerOptions = {},
): SolanaSigner {
    const trimmed = text.trim()
    if (trimmed === "") throw new Error(`empty key file; expected ${ACCEPTED_SECRET_FORMATS}`)

    if (trimmed.startsWith("[")) {
        let parsed: unknown
        try {
            parsed = JSON.parse(trimmed)
        } catch {
            throw new Error("key file looks like a JSON array but does not parse")
        }
        if (!Array.isArray(parsed) || !parsed.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) {
            throw new Error("JSON key file must be an array of bytes (0-255)")
        }
        return { keypair: fromBytes(Uint8Array.from(parsed as number[]), "JSON byte array"), kind: "json-array" }
    }

    const words = trimmed.split(/\s+/)
    if (words.length > 1) {
        if (!MNEMONIC_WORD_COUNTS.has(words.length)) {
            throw new Error(`mnemonic must have 12, 15, 18, 21 or 24 words, got ${words.length}`)
        }
        const mnemonic = words.map(w => w.toLowerCase()).join(" ")
        if (!bip39.validateMnemonic(mnemonic)) {
            throw new Error("mnemonic failed BIP-39 validation (unknown word or bad checksum)")
        }
        const account = options.account ?? 0
        checkAccount(account)
        const seed = bip39.mnemonicToSeedSync(mnemonic, options.passphrase ?? "")
        const derivationPath = solanaDerivationPath(account)
        const { key } = derivePath(derivationPath, seed.toString("hex"))
        return { keypair: Keypair.fromSeed(Uint8Array.from(key)), kind: "mnemonic", derivationPath }
    }

    if (BASE58_RE.test(trimmed)) {
        let bytes: Uint8Array
        try {
            bytes = bs58.decode(trimmed)
        } catch {
            throw new Error("base58 private key does not decode")
        }
        return { keypair: fromBytes(bytes, "base58 private key"), kind: "base58" }
    }

    throw new Error(`unrecognised key format; expected ${ACCEPTED_SECRET_FORMATS}`)
}

/** Reads and parses a key file. Errors name the file. */
export function loadSolanaSigner(
    file: string,
    options: SolanaSignerOptions = {},
): SolanaSigner {
    let text: string
    try {
        text = readFileSync(file, "utf8")
    } catch {
        throw new Error(`Solana key file not found or unreadable: ${file}`)
    }
    try {
        return parseSolanaSecret(text, options)
    } catch (e) {
        throw new Error(`${file}: ${e instanceof Error ? e.message : String(e)}`)
    }
}
