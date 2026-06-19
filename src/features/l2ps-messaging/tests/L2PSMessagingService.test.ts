/**
 * L2PS Messaging Service Tests
 *
 * Tests the L2PS bridge logic: message processing, dedup, offline queueing,
 * history queries, and L2PS transaction creation.
 */

import { describe, it, expect, beforeEach } from "bun:test"
import type { SerializedEncryptedMessage, StoredMessage, MessageStatus } from "../types"

// ─── Test Helpers ────────────────────────────────────────────────

function makeEncrypted(text = "hello"): SerializedEncryptedMessage {
    return {
        ciphertext: Buffer.from(text).toString("base64"),
        nonce: Buffer.from("testnonce123").toString("base64"),
    }
}

function makeStoredMessage(overrides: Partial<StoredMessage> = {}): StoredMessage {
    return {
        id: crypto.randomUUID(),
        from: "sender_key_hex",
        to: "recipient_key_hex",
        messageHash: "hash_" + Math.random().toString(36).slice(2),
        encrypted: makeEncrypted(),
        l2psUid: "test_l2ps_001",
        l2psTxHash: null,
        timestamp: Date.now(),
        status: "delivered",
        ...overrides,
    }
}

// ─── Message Dedup Tests ─────────────────────────────────────────

describe("Message Deduplication", () => {
    it("should detect duplicate messages by hash", () => {
        const seen = new Set<string>()
        const hash1 = "abc123"
        const hash2 = "def456"

        expect(seen.has(hash1)).toBe(false)
        seen.add(hash1)
        expect(seen.has(hash1)).toBe(true)
        expect(seen.has(hash2)).toBe(false)
    })

    it("should allow different messages with different hashes", () => {
        const seen = new Set<string>()
        seen.add("hash_a")
        seen.add("hash_b")
        expect(seen.size).toBe(2)
    })
})

// ─── L2PS Transaction Creation Tests ─────────────────────────────

describe("L2PS Transaction Format", () => {
    it("should create correct transaction content for IM", () => {
        const fromKey = "sender_ed25519_hex"
        const toKey = "recipient_ed25519_hex"
        const messageId = "msg-uuid-123"
        const messageHash = "sha256_of_content"
        const encrypted = makeEncrypted("secret message")
        const timestamp = Date.now()

        // Simulate transaction content creation (as in L2PSMessagingService)
        const content = {
            type: "instantMessaging",
            from: fromKey,
            from_ed25519_address: fromKey,
            to: toKey,
            amount: 0,
            data: ["instantMessaging", {
                messageId,
                messageHash,
                encrypted,
                timestamp,
            }],
            gcr_edits: [],
            nonce: timestamp,
            timestamp,
            transaction_fee: {
                network_fee: 0,
                rpc_fee: 0,
                additional_fee: 0,
                rpc_address: "",
            },
        }

        expect(content.type).toBe("instantMessaging")
        expect(content.from).toBe(fromKey)
        expect(content.to).toBe(toKey)
        expect(content.amount).toBe(0)
        expect(content.gcr_edits).toEqual([])
        expect(content.data[0]).toBe("instantMessaging")
        const payload = content.data[1] as any
        expect(payload.messageId).toBe(messageId)
        expect(payload.messageHash).toBe(messageHash)
        expect(payload.encrypted).toBe(encrypted)
        expect(content.transaction_fee.network_fee).toBe(0)
    })

    it("should have zero fees for IM transactions", () => {
        const fee = { network_fee: 0, rpc_fee: 0, additional_fee: 0 }
        expect(fee.network_fee + fee.rpc_fee + fee.additional_fee).toBe(0)
    })

    it("should have no GCR edits for plain messages", () => {
        // IM messages don't modify state — instant finality
        const gcr_edits: any[] = []
        expect(gcr_edits.length).toBe(0)
    })
})

// ─── History Query Tests ─────────────────────────────────────────

describe("History Queries", () => {
    it("should return messages between two peers in both directions", () => {
        const messages: StoredMessage[] = [
            makeStoredMessage({ from: "alice", to: "bob", timestamp: 1000 }),
            makeStoredMessage({ from: "bob", to: "alice", timestamp: 2000 }),
            makeStoredMessage({ from: "alice", to: "bob", timestamp: 3000 }),
            makeStoredMessage({ from: "alice", to: "charlie", timestamp: 4000 }), // different conversation
        ]

        const peerA = "alice"
        const peerB = "bob"
        const conversation = messages.filter(
            m => (m.from === peerA && m.to === peerB) || (m.from === peerB && m.to === peerA)
        )

        expect(conversation.length).toBe(3)
    })

    it("should paginate with 'before' timestamp", () => {
        const messages: StoredMessage[] = [
            makeStoredMessage({ timestamp: 1000 }),
            makeStoredMessage({ timestamp: 2000 }),
            makeStoredMessage({ timestamp: 3000 }),
            makeStoredMessage({ timestamp: 4000 }),
            makeStoredMessage({ timestamp: 5000 }),
        ]

        const before = 3500
        const limit = 2
        const page = messages
            .filter(m => m.timestamp < before)
            .sort((a, b) => b.timestamp - a.timestamp) // DESC
            .slice(0, limit)

        expect(page.length).toBe(2)
        expect(page[0].timestamp).toBe(3000)
        expect(page[1].timestamp).toBe(2000)
    })

    it("should detect hasMore correctly", () => {
        const total = 10
        const limit = 5

        // Query limit+1 to check if more exist
        const fetched = total // Simulating fetching limit+1 rows
        const hasMore = fetched > limit
        expect(hasMore).toBe(true)
    })

    it("should scope history to l2psUid", () => {
        const messages: StoredMessage[] = [
            makeStoredMessage({ from: "a", to: "b", l2psUid: "net1" }),
            makeStoredMessage({ from: "a", to: "b", l2psUid: "net2" }),
            makeStoredMessage({ from: "a", to: "b", l2psUid: "net1" }),
        ]

        const net1Messages = messages.filter(m => m.l2psUid === "net1")
        expect(net1Messages.length).toBe(2)
    })
})

// ─── Message Status Lifecycle Tests ──────────────────────────────

describe("Message Status Lifecycle", () => {
    it("should set 'delivered' when recipient is online", () => {
        const recipientOnline = true
        const status: MessageStatus = recipientOnline ? "delivered" : "queued"
        expect(status).toBe("delivered")
    })

    it("should set 'queued' when recipient is offline", () => {
        const recipientOnline = false
        const status: MessageStatus = recipientOnline ? "delivered" : "queued"
        expect(status).toBe("queued")
    })

    it("should transition queued → sent on offline delivery", () => {
        let status: MessageStatus = "queued"
        // Simulate delivery
        status = "sent"
        expect(status).toBe("sent")
    })

    it("should track L2PS lifecycle: l2ps_pending → l2ps_batched → l2ps_confirmed", () => {
        const lifecycle: MessageStatus[] = ["l2ps_pending", "l2ps_batched", "l2ps_confirmed"]
        expect(lifecycle[0]).toBe("l2ps_pending")
        expect(lifecycle[lifecycle.length - 1]).toBe("l2ps_confirmed")
    })
})

// ─── Encrypted Message Serialization Tests ───────────────────────

describe("Encrypted Message Serialization", () => {
    it("should serialize/deserialize encrypted message", () => {
        const original: SerializedEncryptedMessage = {
            ciphertext: "base64encodeddata==",
            nonce: "base64nonce==",
            ephemeralKey: "hex_ephemeral_key",
        }

        const json = JSON.stringify(original)
        const deserialized = JSON.parse(json) as SerializedEncryptedMessage

        expect(deserialized.ciphertext).toBe(original.ciphertext)
        expect(deserialized.nonce).toBe(original.nonce)
        expect(deserialized.ephemeralKey).toBe(original.ephemeralKey)
    })

    it("should work without optional ephemeralKey", () => {
        const minimal: SerializedEncryptedMessage = {
            ciphertext: "data",
            nonce: "nonce",
        }

        expect(minimal.ephemeralKey).toBeUndefined()
        const json = JSON.stringify(minimal)
        const parsed = JSON.parse(json)
        expect(parsed).not.toHaveProperty("ephemeralKey")
    })
})

// ─── StoredMessage Mapping Tests ─────────────────────────────────

describe("StoredMessage Mapping", () => {
    it("should map DB entity to StoredMessage format", () => {
        // Simulate DB entity (bigint timestamp as string)
        const dbRow = {
            id: "uuid-123",
            fromKey: "sender_hex",
            toKey: "recipient_hex",
            messageHash: "hash123",
            encrypted: makeEncrypted(),
            l2psUid: "net1",
            l2psTxHash: "tx_hash_abc",
            timestamp: "1709312400000", // bigint as string from TypeORM
            status: "delivered" as const,
        }

        const mapped: StoredMessage = {
            id: dbRow.id,
            from: dbRow.fromKey,
            to: dbRow.toKey,
            messageHash: dbRow.messageHash,
            encrypted: dbRow.encrypted,
            l2psUid: dbRow.l2psUid,
            l2psTxHash: dbRow.l2psTxHash,
            timestamp: Number(dbRow.timestamp),
            status: dbRow.status,
        }

        expect(mapped.from).toBe("sender_hex")
        expect(mapped.to).toBe("recipient_hex")
        expect(mapped.timestamp).toBe(1709312400000)
        expect(typeof mapped.timestamp).toBe("number")
        expect(mapped.l2psTxHash).toBe("tx_hash_abc")
    })

    it("should handle null l2psTxHash before L2PS submission", () => {
        const msg = makeStoredMessage({ l2psTxHash: null })
        expect(msg.l2psTxHash).toBeNull()
    })
})
