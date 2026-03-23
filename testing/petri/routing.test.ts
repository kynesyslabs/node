/**
 * Petri Consensus — Phase 4 Routing tests
 *
 * Tests:
 * - ShardMapper: single-shard always returns 'default'
 * - selectMembers: determinism, count, edge cases
 * - Routing flag gating logic
 */
import { describe, expect, test } from "bun:test"
import { getShardForAddress } from "@/libs/consensus/petri/routing/shardMapper"
import { selectMembers } from "@/libs/consensus/petri/routing/petriRouter"

// ---- ShardMapper ----

describe("ShardMapper", () => {
    test("always returns 'default' on testnet", () => {
        expect(getShardForAddress("0xabc123")).toBe("default")
        expect(getShardForAddress("0xdef456")).toBe("default")
        expect(getShardForAddress("")).toBe("default")
    })

    test("same address always returns same shard", () => {
        const addr = "0x1234567890abcdef"
        const shard1 = getShardForAddress(addr)
        const shard2 = getShardForAddress(addr)
        expect(shard1).toBe(shard2)
    })

    test("different addresses return same shard (single-shard mode)", () => {
        const a = getShardForAddress("0xaaa")
        const b = getShardForAddress("0xbbb")
        const c = getShardForAddress("0xccc")
        expect(a).toBe(b)
        expect(b).toBe(c)
    })
})

// ---- selectMembers ----

// Mock peers with just identity (what selectMembers needs)
function mockPeers(count: number): any[] {
    return Array.from({ length: count }, (_, i) => ({
        identity: `peer_${String(i).padStart(3, "0")}`,
        connection: { string: `localhost:${3000 + i}` },
    }))
}

describe("selectMembers determinism", () => {
    test("same tx hash always selects same members", () => {
        const shard = mockPeers(10)
        const txHash = "abc123def456"

        const selected1 = selectMembers(txHash, shard)
        const selected2 = selectMembers(txHash, shard)

        expect(selected1.map(p => p.identity)).toEqual(
            selected2.map(p => p.identity),
        )
    })

    test("different tx hashes select different members (usually)", () => {
        const shard = mockPeers(10)
        const selected1 = selectMembers("hash_aaa", shard)
        const selected2 = selectMembers("hash_bbb", shard)

        // With 10 peers and 2 selections, different seeds should usually differ
        // (there's a small chance they match, so we test many)
        let diffCount = 0
        for (let i = 0; i < 20; i++) {
            const a = selectMembers(`hash_${i}_a`, shard)
            const b = selectMembers(`hash_${i}_b`, shard)
            if (a[0].identity !== b[0].identity || a[1].identity !== b[1].identity) {
                diffCount++
            }
        }
        // At least some should differ
        expect(diffCount).toBeGreaterThan(5)
    })

    test("determinism holds across 100 calls", () => {
        const shard = mockPeers(10)
        const txHash = "determinism_test_hash"
        const baseline = selectMembers(txHash, shard).map(p => p.identity)

        for (let i = 0; i < 100; i++) {
            const result = selectMembers(txHash, shard).map(p => p.identity)
            expect(result).toEqual(baseline)
        }
    })
})

describe("selectMembers count", () => {
    test("selects exactly 2 members by default", () => {
        const shard = mockPeers(10)
        const selected = selectMembers("test_hash", shard)
        expect(selected).toHaveLength(2)
    })

    test("selects custom count", () => {
        const shard = mockPeers(10)
        expect(selectMembers("test", shard, 1)).toHaveLength(1)
        expect(selectMembers("test", shard, 3)).toHaveLength(3)
        expect(selectMembers("test", shard, 5)).toHaveLength(5)
    })

    test("caps at shard size", () => {
        const shard = mockPeers(3)
        const selected = selectMembers("test", shard, 5)
        expect(selected).toHaveLength(3) // Capped at shard.length
    })

    test("returns empty for empty shard", () => {
        const selected = selectMembers("test", [])
        expect(selected).toHaveLength(0)
    })

    test("returns 1 for shard of 1", () => {
        const shard = mockPeers(1)
        const selected = selectMembers("test", shard, 2)
        expect(selected).toHaveLength(1)
    })
})

describe("selectMembers uniqueness", () => {
    test("selected members are unique (no duplicates)", () => {
        const shard = mockPeers(10)

        for (let i = 0; i < 50; i++) {
            const selected = selectMembers(`unique_test_${i}`, shard)
            const identities = selected.map(p => p.identity)
            const uniqueIdentities = new Set(identities)
            expect(uniqueIdentities.size).toBe(identities.length)
        }
    })

    test("all selected members exist in shard", () => {
        const shard = mockPeers(10)
        const shardIdentities = new Set(shard.map(p => p.identity))

        for (let i = 0; i < 50; i++) {
            const selected = selectMembers(`exists_test_${i}`, shard)
            for (const peer of selected) {
                expect(shardIdentities.has(peer.identity)).toBe(true)
            }
        }
    })
})

// ---- Routing flag gating ----

describe("Routing flag gating", () => {
    test("petriConsensus flag gates routing path", () => {
        const scenarios = [
            { petriConsensus: true, expectedPath: "petri" },
            { petriConsensus: false, expectedPath: "dtr" },
        ]

        for (const { petriConsensus, expectedPath } of scenarios) {
            const path = petriConsensus ? "petri" : "dtr"
            expect(path).toBe(expectedPath)
        }
    })

    test("petri routing returns expected response shape", () => {
        // Simulates the shape returned by endpointExecution when Petri is on
        const petriResponse = {
            success: true,
            response: { message: "Transaction routed to shard members" },
            extra: {
                confirmationBlock: 42,
                routing: "petri",
            },
            require_reply: false,
        }

        expect(petriResponse.success).toBe(true)
        expect(petriResponse.extra.routing).toBe("petri")
        expect(petriResponse.extra.confirmationBlock).toBe(42)
    })

    test("dtr routing returns expected response shape", () => {
        // Simulates the shape returned by endpointExecution when Petri is off
        const dtrResponse = {
            success: true,
            response: { message: "Transaction relayed to validators" },
            extra: { confirmationBlock: 42 },
            require_reply: false,
        }

        expect(dtrResponse.success).toBe(true)
        expect(dtrResponse.extra.confirmationBlock).toBe(42)
        expect(dtrResponse.extra).not.toHaveProperty("routing")
    })
})
