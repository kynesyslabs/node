import { describe, expect, it } from "bun:test"
import crypto from "crypto"

import bs58 from "bs58"

import { ed25519SignerVerifier } from "@/libs/atomic-work/workEnvelope"

/**
 * Which signer claims a validator can verify on its own. A `did:key` is the
 * key itself, so it verifies everywhere alike; a DID that only names a key
 * would need resolving, which validators could do differently.
 */
function keypair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519")
    const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32)
    return { raw, privateKey }
}

const didKey = (raw: Buffer, codec = [0xed, 0x01]) =>
    "did:key:z" + bs58.encode(Buffer.concat([Buffer.from(codec), raw]))

const sign = (privateKey: crypto.KeyObject, bytes: string) =>
    crypto.sign(null, Buffer.from(bytes, "utf8"), privateKey).toString("hex")

describe("ed25519SignerVerifier", () => {
    const signedBytes = "demos-atomic-authorization:v1:example"

    it("verifies a signer given as an ed25519 did:key", () => {
        const { raw, privateKey } = keypair()
        const signature = sign(privateKey, signedBytes)

        expect(ed25519SignerVerifier({ signer: didKey(raw), signedBytes, signature })).toBe(true)
        expect(ed25519SignerVerifier({ signer: { publicKey: didKey(raw) }, signedBytes, signature })).toBe(true)
    })

    it("still verifies a raw hex key", () => {
        const { raw, privateKey } = keypair()
        const signature = sign(privateKey, signedBytes)
        expect(ed25519SignerVerifier({ signer: "0x" + raw.toString("hex"), signedBytes, signature })).toBe(true)
    })

    it("refuses a did:key that names a different key", () => {
        const signer = keypair()
        const other = keypair()
        const signature = sign(signer.privateKey, signedBytes)
        expect(ed25519SignerVerifier({ signer: didKey(other.raw), signedBytes, signature })).toBe(false)
    })

    it("refuses a did:key for another key type, and DIDs that need resolving", () => {
        const { raw, privateKey } = keypair()
        const signature = sign(privateKey, signedBytes)
        for (const signer of [
            didKey(raw, [0xe7, 0x01]), // secp256k1 multicodec
            "did:dacs:test:buyer",
            "did:web:example.com",
            "did:key:zNotBase58!",
        ]) {
            expect(ed25519SignerVerifier({ signer, signedBytes, signature })).toBe(false)
        }
    })
})
