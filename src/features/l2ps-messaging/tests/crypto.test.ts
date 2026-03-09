/**
 * L2PS Messaging Crypto Tests
 */

import { describe, it, expect } from "bun:test"
import {
    computeMessageHash,
    encryptMessage,
    decryptMessage,
    generateSymmetricKey,
} from "../crypto"

describe("computeMessageHash", () => {
    it("should produce consistent hash for same inputs", () => {
        const h1 = computeMessageHash("alice", "bob", "hello", 1000)
        const h2 = computeMessageHash("alice", "bob", "hello", 1000)
        expect(h1).toBe(h2)
    })

    it("should produce different hashes for different inputs", () => {
        const h1 = computeMessageHash("alice", "bob", "hello", 1000)
        const h2 = computeMessageHash("alice", "bob", "world", 1000)
        const h3 = computeMessageHash("bob", "alice", "hello", 1000)
        expect(h1).not.toBe(h2)
        expect(h1).not.toBe(h3)
    })

    it("should return a hex string", () => {
        const hash = computeMessageHash("a", "b", "c", 0)
        expect(hash).toMatch(/^[0-9a-f]+$/)
    })
})

describe("generateSymmetricKey", () => {
    it("should generate 32-byte key", () => {
        const key = generateSymmetricKey()
        expect(key.length).toBe(32)
        expect(key).toBeInstanceOf(Uint8Array)
    })

    it("should generate unique keys", () => {
        const k1 = generateSymmetricKey()
        const k2 = generateSymmetricKey()
        expect(Buffer.from(k1).toString("hex")).not.toBe(Buffer.from(k2).toString("hex"))
    })
})

describe("encryptMessage / decryptMessage", () => {
    it("should encrypt and decrypt a message", async () => {
        const key = generateSymmetricKey()
        const plaintext = "Hello, this is a secret message!"

        const encrypted = await encryptMessage(plaintext, key)
        expect(encrypted.ciphertext).toBeDefined()
        expect(encrypted.nonce).toBeDefined()
        expect(encrypted.ciphertext).not.toBe(plaintext)

        const decrypted = await decryptMessage(encrypted, key)
        expect(decrypted).toBe(plaintext)
    })

    it("should encrypt empty string", async () => {
        const key = generateSymmetricKey()
        const encrypted = await encryptMessage("", key)
        const decrypted = await decryptMessage(encrypted, key)
        expect(decrypted).toBe("")
    })

    it("should encrypt unicode content", async () => {
        const key = generateSymmetricKey()
        const text = "Привет мир! 🌍🔑"
        const encrypted = await encryptMessage(text, key)
        const decrypted = await decryptMessage(encrypted, key)
        expect(decrypted).toBe(text)
    })

    it("should encrypt large messages", async () => {
        const key = generateSymmetricKey()
        const text = "A".repeat(100_000)
        const encrypted = await encryptMessage(text, key)
        const decrypted = await decryptMessage(encrypted, key)
        expect(decrypted).toBe(text)
    })

    it("should produce different ciphertext for same plaintext (random nonce)", async () => {
        const key = generateSymmetricKey()
        const e1 = await encryptMessage("same", key)
        const e2 = await encryptMessage("same", key)
        expect(e1.ciphertext).not.toBe(e2.ciphertext)
        expect(e1.nonce).not.toBe(e2.nonce)
    })

    it("should fail to decrypt with wrong key", async () => {
        const key1 = generateSymmetricKey()
        const key2 = generateSymmetricKey()
        const encrypted = await encryptMessage("secret", key1)

        try {
            await decryptMessage(encrypted, key2)
            expect(true).toBe(false) // should not reach
        } catch (error) {
            expect(error).toBeDefined()
        }
    })

    it("should fail to decrypt with tampered ciphertext", async () => {
        const key = generateSymmetricKey()
        const encrypted = await encryptMessage("secret", key)

        // Tamper with ciphertext
        const bytes = Buffer.from(encrypted.ciphertext, "base64")
        bytes[0] ^= 0xff
        encrypted.ciphertext = bytes.toString("base64")

        try {
            await decryptMessage(encrypted, key)
            expect(true).toBe(false)
        } catch (error) {
            expect(error).toBeDefined()
        }
    })

    it("should produce base64 output", async () => {
        const key = generateSymmetricKey()
        const encrypted = await encryptMessage("test", key)
        // base64 chars: A-Z, a-z, 0-9, +, /, =
        expect(encrypted.ciphertext).toMatch(/^[A-Za-z0-9+/=]+$/)
        expect(encrypted.nonce).toMatch(/^[A-Za-z0-9+/=]+$/)
    })
})
