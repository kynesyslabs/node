import { afterAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Keypair } from "@solana/web3.js"
import * as bip39 from "bip39"
import bs58 from "bs58"
import { derivePath } from "ed25519-hd-key"

import {
    ACCEPTED_SECRET_FORMATS,
    loadSolanaSigner,
    parseSolanaSecret,
    solanaDerivationPath,
} from "./solana-signer"

const tmp = mkdtempSync(join(tmpdir(), "solana-signer-"))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

function fileWith(name: string, text: string): string {
    const file = join(tmp, name)
    writeFileSync(file, text)
    return file
}

const reference = Keypair.generate()
const pubkey = reference.publicKey.toBase58()

// The BIP-39 test vector mnemonic; the expected keys are derived with the
// same libraries Phantom-compatible tooling uses, so a regression in the
// path or seed handling shows up as a pubkey mismatch.
const MNEMONIC =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
function mnemonicPubkey(account: number, passphrase = ""): string {
    const seed = bip39.mnemonicToSeedSync(MNEMONIC, passphrase).toString("hex")
    const { key } = derivePath(solanaDerivationPath(account), seed)
    return Keypair.fromSeed(Uint8Array.from(key)).publicKey.toBase58()
}

describe("parseSolanaSecret", () => {
    it("accepts a solana-keygen JSON byte array", () => {
        const signer = parseSolanaSecret(JSON.stringify(Array.from(reference.secretKey)))
        expect(signer.kind).toBe("json-array")
        expect(signer.keypair.publicKey.toBase58()).toBe(pubkey)
    })

    it("accepts a 32-byte JSON seed", () => {
        const seed = reference.secretKey.slice(0, 32)
        const signer = parseSolanaSecret(`[${Array.from(seed).join(",")}]`)
        expect(signer.kind).toBe("json-array")
        expect(signer.keypair.publicKey.toBase58()).toBe(pubkey)
    })

    it("accepts a base58 private key (wallet export)", () => {
        const signer = parseSolanaSecret(bs58.encode(reference.secretKey))
        expect(signer.kind).toBe("base58")
        expect(signer.keypair.publicKey.toBase58()).toBe(pubkey)
    })

    it("accepts a base58 32-byte seed", () => {
        const signer = parseSolanaSecret(bs58.encode(reference.secretKey.slice(0, 32)))
        expect(signer.kind).toBe("base58")
        expect(signer.keypair.publicKey.toBase58()).toBe(pubkey)
    })

    it("accepts a 12-word mnemonic at account 0 by default", () => {
        const signer = parseSolanaSecret(MNEMONIC)
        expect(signer.kind).toBe("mnemonic")
        expect(signer.derivationPath).toBe("m/44'/501'/0'/0'")
        expect(signer.keypair.publicKey.toBase58()).toBe(mnemonicPubkey(0))
    })

    it("derives a different account when asked", () => {
        const signer = parseSolanaSecret(MNEMONIC, { account: 3 })
        expect(signer.derivationPath).toBe("m/44'/501'/3'/0'")
        expect(signer.keypair.publicKey.toBase58()).toBe(mnemonicPubkey(3))
        expect(signer.keypair.publicKey.toBase58()).not.toBe(mnemonicPubkey(0))
    })

    it("applies a BIP-39 passphrase", () => {
        const signer = parseSolanaSecret(MNEMONIC, { passphrase: "TREZOR" })
        expect(signer.keypair.publicKey.toBase58()).toBe(mnemonicPubkey(0, "TREZOR"))
        expect(signer.keypair.publicKey.toBase58()).not.toBe(mnemonicPubkey(0))
    })

    it("accepts a 24-word mnemonic and ignores case and spacing", () => {
        const words = bip39.generateMnemonic(256)
        const messy = `  ${words.toUpperCase().split(" ").join("\n ")}\n`
        const signer = parseSolanaSecret(messy)
        expect(signer.kind).toBe("mnemonic")
        const seed = bip39.mnemonicToSeedSync(words).toString("hex")
        const { key } = derivePath(solanaDerivationPath(0), seed)
        expect(signer.keypair.publicKey.toBase58()).toBe(
            Keypair.fromSeed(Uint8Array.from(key)).publicKey.toBase58(),
        )
    })

    it("all three formats of the same key yield the same signer", () => {
        const fromJson = parseSolanaSecret(JSON.stringify(Array.from(reference.secretKey)))
        const fromBase58 = parseSolanaSecret(bs58.encode(reference.secretKey))
        expect(fromJson.keypair.publicKey.toBase58()).toBe(fromBase58.keypair.publicKey.toBase58())
        expect(Buffer.from(fromJson.keypair.secretKey)).toEqual(Buffer.from(fromBase58.keypair.secretKey))
    })

    it("rejects what it cannot read with a message naming the formats", () => {
        expect(() => parseSolanaSecret("")).toThrow(ACCEPTED_SECRET_FORMATS)
        expect(() => parseSolanaSecret("0xdeadbeef")).toThrow(ACCEPTED_SECRET_FORMATS)
        expect(() => parseSolanaSecret("[1, 2, 3")).toThrow("does not parse")
        expect(() => parseSolanaSecret("[1, 2, 300]")).toThrow("array of bytes")
        expect(() => parseSolanaSecret("[1, 2, 3]")).toThrow("64 bytes")
        expect(() => parseSolanaSecret(bs58.encode(Buffer.alloc(10)))).toThrow("64 bytes")
        expect(() => parseSolanaSecret("abandon abandon abandon")).toThrow("12, 15, 18, 21 or 24 words")
        expect(() => parseSolanaSecret(MNEMONIC.replace("about", "abandon"))).toThrow("BIP-39 validation")
        expect(() => parseSolanaSecret(MNEMONIC, { account: -1 })).toThrow("account index")
        expect(() => parseSolanaSecret(MNEMONIC, { account: 1.5 })).toThrow("account index")
    })
})

describe("loadSolanaSigner", () => {
    it("reads each format from disk", () => {
        const json = fileWith("id.json", JSON.stringify(Array.from(reference.secretKey)))
        const b58 = fileWith("key.txt", `${bs58.encode(reference.secretKey)}\n`)
        const words = fileWith("seed.txt", `${MNEMONIC}\n`)
        expect(loadSolanaSigner(json).keypair.publicKey.toBase58()).toBe(pubkey)
        expect(loadSolanaSigner(b58).keypair.publicKey.toBase58()).toBe(pubkey)
        expect(loadSolanaSigner(words, { account: 1 }).keypair.publicKey.toBase58()).toBe(mnemonicPubkey(1))
    })

    it("names the file in errors", () => {
        const bad = fileWith("bad.txt", "not a key")
        expect(() => loadSolanaSigner(bad)).toThrow(bad)
        expect(() => loadSolanaSigner(join(tmp, "missing"))).toThrow("not found or unreadable")
    })
})
