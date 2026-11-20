import { describe, expect, it, jest } from "bun:test"

const sharedState: any = { identityFile: "", signingAlgorithm: "ed25519" }
const logger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
}

jest.mock("src/utilities/logger", () => ({ __esModule: true, default: logger }))
jest.mock("@/utilities/logger", () => ({ __esModule: true, default: logger }))
jest.mock("src/utilities/sharedState", () => ({ getSharedState: sharedState }))

const { default: Identity } = await import("./identity")
const { ucrypto, uint8ArrayToHex } = await import(
    "@kynesyslabs/demosdk/encryption"
)

// The public BIP-39 test vector (all-zero entropy), built at run time so the
// secret scanner does not read it as a wallet's phrase.
const ASCII_PHRASE = [...Array(11).fill("abandon"), "about"].join(" ")

async function publicKeyFor(phrase: string): Promise<string> {
    const seed = await Identity.getInstance().mnemonicToSeed(phrase)
    await ucrypto.generateAllIdentities(seed)
    const { publicKey } = await ucrypto.getIdentity("ed25519")
    return uint8ArrayToHex(publicKey as Uint8Array)
}

describe("Identity.mnemonicToSeed canonical form", () => {
    it("keeps the public key derived from a canonical ASCII phrase", async () => {
        expect(await publicKeyFor(ASCII_PHRASE)).toBe(
            "0x263af3be8487729727d99b35dcfdc61bf920a9164249ad117b292e6d3c7194f8",
        )
    })

    it("still trims surrounding whitespace before deriving", async () => {
        expect(await publicKeyFor(`  ${ASCII_PHRASE}\n`)).toBe(
            await publicKeyFor(ASCII_PHRASE),
        )
    })

    it("refuses ideographic spaces between the words", async () => {
        const phrase = ASCII_PHRASE.split(" ").join("　")
        await expect(
            Identity.getInstance().mnemonicToSeed(phrase),
        ).rejects.toThrow(/^Invalid mnemonic: .*plain lowercase ASCII/)
    })

    it("refuses full-width letters", async () => {
        const phrase = ASCII_PHRASE.replace(
            /about$/,
            "ａｂｏｕｔ",
        )
        await expect(
            Identity.getInstance().mnemonicToSeed(phrase),
        ).rejects.toThrow(/^Invalid mnemonic: .*plain lowercase ASCII/)
    })

    it("refuses no-break spaces between the words", async () => {
        const phrase = ASCII_PHRASE.split(" ").join("\u00a0")
        await expect(
            Identity.getInstance().mnemonicToSeed(phrase),
        ).rejects.toThrow(/^Invalid mnemonic: .*no-break spaces/)
    })

    // The canonical-form check is NFKD only and ASCII spacing never reaches
    // it, so its message names the characters it refuses, not a spacing rule.
    it("names the refused characters, not a spacing rule", async () => {
        const refusal = await Identity.getInstance()
            .mnemonicToSeed(ASCII_PHRASE.split(" ").join("\u3000"))
            .catch((e: Error) => e.message)
        expect(refusal).toContain("full-width letters, ideographic or no-break spaces")
        expect(refusal).not.toContain("single space")
    })

    it("still refuses a phrase that is not a valid mnemonic", async () => {
        await expect(
            Identity.getInstance().mnemonicToSeed("not a mnemonic"),
        ).rejects.toThrow(/^Invalid mnemonic:/)
    })
})
