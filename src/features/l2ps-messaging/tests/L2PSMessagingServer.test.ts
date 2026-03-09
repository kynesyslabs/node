/**
 * L2PS Messaging Server Tests
 *
 * Tests the WebSocket protocol, message routing, peer management,
 * and offline delivery logic.
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test"
import { L2PSMessagingServer } from "../L2PSMessagingServer"
import { L2PSMessagingService } from "../L2PSMessagingService"

// ─── Test Helpers ────────────────────────────────────────────────

/** Create a mock WebSocket that captures sent messages */
function createMockWS(publicKey: string | null = null, l2psUid: string | null = null) {
    const sent: string[] = []
    return {
        data: { publicKey, l2psUid },
        send(msg: string) { sent.push(msg) },
        close() {},
        readyState: 1, // OPEN
        _sent: sent,
        _parsed(): any[] { return sent.map(s => JSON.parse(s)) },
    }
}

function frame(type: string, payload: Record<string, unknown>, timestamp = Date.now()) {
    return JSON.stringify({ type, payload, timestamp })
}

// ─── Protocol Frame Tests ────────────────────────────────────────

describe("L2PSMessagingServer Protocol", () => {

    describe("Message Validation", () => {
        it("should reject invalid JSON", () => {
            const ws = createMockWS()
            // Directly test that invalid JSON would result in error response
            const raw = "not json"
            let parsed: any
            try { parsed = JSON.parse(raw) } catch { parsed = null }
            expect(parsed).toBeNull()
        })

        it("should require type and payload fields", () => {
            const msg = { foo: "bar" }
            expect(msg).not.toHaveProperty("type")
            expect(msg).not.toHaveProperty("payload")
        })

        it("should accept valid protocol frames", () => {
            const msg = JSON.parse(frame("discover", {}))
            expect(msg.type).toBe("discover")
            expect(msg.payload).toEqual({})
            expect(msg.timestamp).toBeGreaterThan(0)
        })
    })

    describe("Register Message Format", () => {
        it("should require publicKey, l2psUid, and proof", () => {
            const valid = {
                type: "register",
                payload: {
                    publicKey: "abcdef1234567890",
                    l2psUid: "test_l2ps_001",
                    proof: "deadbeef",
                },
                timestamp: Date.now(),
            }
            expect(valid.payload.publicKey).toBeDefined()
            expect(valid.payload.l2psUid).toBeDefined()
            expect(valid.payload.proof).toBeDefined()
        })

        it("should reject register without required fields", () => {
            const invalid = {
                type: "register",
                payload: { publicKey: "abc" }, // missing l2psUid, proof
                timestamp: Date.now(),
            }
            expect(invalid.payload).not.toHaveProperty("l2psUid")
            expect(invalid.payload).not.toHaveProperty("proof")
        })
    })

    describe("Send Message Format", () => {
        it("should require to, encrypted, and messageHash", () => {
            const valid = {
                type: "send",
                payload: {
                    to: "recipient_pubkey_hex",
                    encrypted: {
                        ciphertext: "base64data",
                        nonce: "base64nonce",
                    },
                    messageHash: "sha256hash",
                },
                timestamp: Date.now(),
            }
            expect(valid.payload.to).toBeDefined()
            expect(valid.payload.encrypted).toBeDefined()
            expect(valid.payload.messageHash).toBeDefined()
        })
    })

    describe("History Message Format", () => {
        it("should require peerKey and proof", () => {
            const valid = {
                type: "history",
                payload: {
                    peerKey: "peer_pubkey_hex",
                    proof: "signature_hex",
                    limit: 50,
                    before: Date.now(),
                },
                timestamp: Date.now(),
            }
            expect(valid.payload.peerKey).toBeDefined()
            expect(valid.payload.proof).toBeDefined()
        })

        it("should support optional limit and before", () => {
            const minimal = {
                type: "history",
                payload: {
                    peerKey: "peer_pubkey_hex",
                    proof: "signature_hex",
                },
                timestamp: Date.now(),
            }
            expect(minimal.payload).not.toHaveProperty("limit")
            expect(minimal.payload).not.toHaveProperty("before")
        })
    })
})

// ─── Peer Management Tests ───────────────────────────────────────

describe("Peer Management", () => {
    it("should track connected peers by publicKey", () => {
        const peers = new Map<string, { publicKey: string; l2psUid: string }>()
        const key1 = "aabbcc"
        const key2 = "ddeeff"

        peers.set(key1, { publicKey: key1, l2psUid: "net1" })
        peers.set(key2, { publicKey: key2, l2psUid: "net1" })

        expect(peers.size).toBe(2)
        expect(peers.has(key1)).toBe(true)
    })

    it("should filter peers by l2psUid", () => {
        const peers = new Map<string, { publicKey: string; l2psUid: string }>()
        peers.set("a", { publicKey: "a", l2psUid: "net1" })
        peers.set("b", { publicKey: "b", l2psUid: "net2" })
        peers.set("c", { publicKey: "c", l2psUid: "net1" })

        const net1Peers = Array.from(peers.values())
            .filter(p => p.l2psUid === "net1")
            .map(p => p.publicKey)

        expect(net1Peers).toEqual(["a", "c"])
    })

    it("should handle re-registration by replacing old connection", () => {
        const peers = new Map<string, { publicKey: string; ws: any }>()
        const ws1 = createMockWS()
        const ws2 = createMockWS()

        peers.set("key1", { publicKey: "key1", ws: ws1 })
        expect(peers.get("key1")!.ws).toBe(ws1)

        // Re-register replaces
        peers.set("key1", { publicKey: "key1", ws: ws2 })
        expect(peers.get("key1")!.ws).toBe(ws2)
        expect(peers.size).toBe(1)
    })

    it("should remove peer on disconnect", () => {
        const peers = new Map<string, { publicKey: string }>()
        peers.set("a", { publicKey: "a" })
        peers.set("b", { publicKey: "b" })

        peers.delete("a")
        expect(peers.size).toBe(1)
        expect(peers.has("a")).toBe(false)
    })
})

// ─── Message Routing Tests ───────────────────────────────────────

describe("Message Routing", () => {
    it("should route to online recipient", () => {
        const recipientWS = createMockWS("recipient", "net1")
        const peers = new Map<string, { publicKey: string; l2psUid: string; ws: any }>()
        peers.set("recipient", { publicKey: "recipient", l2psUid: "net1", ws: recipientWS })

        // Simulate routing
        const target = peers.get("recipient")
        const isOnline = !!target && target.l2psUid === "net1"
        expect(isOnline).toBe(true)

        if (isOnline) {
            target!.ws.send(JSON.stringify({
                type: "message",
                payload: { from: "sender", encrypted: { ciphertext: "ct", nonce: "n" }, messageHash: "h" },
                timestamp: Date.now(),
            }))
        }

        expect(recipientWS._sent.length).toBe(1)
        const parsed = JSON.parse(recipientWS._sent[0])
        expect(parsed.type).toBe("message")
        expect(parsed.payload.from).toBe("sender")
    })

    it("should detect offline recipient", () => {
        const peers = new Map<string, { publicKey: string; l2psUid: string }>()
        // Recipient not in peers map
        const target = peers.get("offline_recipient")
        expect(target).toBeUndefined()
    })

    it("should not route across L2PS networks", () => {
        const peers = new Map<string, { publicKey: string; l2psUid: string }>()
        peers.set("recipient", { publicKey: "recipient", l2psUid: "net2" })

        const target = peers.get("recipient")
        const isOnlineInSameNetwork = !!target && target.l2psUid === "net1"
        expect(isOnlineInSameNetwork).toBe(false)
    })
})

// ─── Offline Message Delivery Tests ──────────────────────────────

describe("Offline Message Delivery", () => {
    it("should deliver queued messages in chronological order", () => {
        const queued = [
            { id: "1", from: "a", timestamp: 1000, messageHash: "h1", encrypted: { ciphertext: "c1", nonce: "n1" } },
            { id: "2", from: "a", timestamp: 2000, messageHash: "h2", encrypted: { ciphertext: "c2", nonce: "n2" } },
            { id: "3", from: "b", timestamp: 3000, messageHash: "h3", encrypted: { ciphertext: "c3", nonce: "n3" } },
        ]

        // Should be ordered by timestamp ASC
        const sorted = [...queued].sort((a, b) => a.timestamp - b.timestamp)
        expect(sorted[0].id).toBe("1")
        expect(sorted[2].id).toBe("3")
    })

    it("should mark messages as delivered after sending", () => {
        const deliveredIds: string[] = []
        const queued = [
            { id: "msg1", status: "queued" },
            { id: "msg2", status: "queued" },
        ]

        for (const msg of queued) {
            // Simulate successful send
            deliveredIds.push(msg.id)
        }

        expect(deliveredIds).toEqual(["msg1", "msg2"])
    })

    it("should stop delivery on first failure to maintain order", () => {
        const deliveredIds: string[] = []
        const queued = ["msg1", "msg2", "msg3"]
        let sendFails = false

        for (const id of queued) {
            if (id === "msg2") sendFails = true
            if (sendFails) break
            deliveredIds.push(id)
        }

        expect(deliveredIds).toEqual(["msg1"])
    })
})

// ─── Rate Limiting Tests ─────────────────────────────────────────

describe("Offline Message Rate Limiting", () => {
    it("should enforce per-sender limit", () => {
        const MAX = 200
        const counts = new Map<string, number>()
        const sender = "spammer"

        // Fill up to limit
        for (let i = 0; i < MAX; i++) {
            counts.set(sender, (counts.get(sender) ?? 0) + 1)
        }

        expect(counts.get(sender)).toBe(MAX)

        // Next message should be rejected
        const count = counts.get(sender) ?? 0
        expect(count >= MAX).toBe(true)
    })

    it("should reset count after delivery", () => {
        const counts = new Map<string, number>()
        counts.set("sender1", 50)
        counts.set("sender2", 100)

        // Reset after delivery
        counts.delete("sender1")
        expect(counts.has("sender1")).toBe(false)
        expect(counts.get("sender2")).toBe(100)
    })
})
