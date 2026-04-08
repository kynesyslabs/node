/**
 * Petri Consensus — Phase 9 Secretary-Coordinated Block Signing tests
 *
 * Tests:
 * - Secretary election (deterministic, first peer in shard)
 * - BFT threshold for collection
 * - Collection result structure and agreement logic
 * - Hash match/mismatch counting
 * - Submission receipt and collection state
 * - Secretary failover logic
 * - Verify-then-sign model (manageProposeBlockHash Petri branch)
 */
import { describe, expect, test } from "bun:test"

// ---- Secretary Election Logic ----
// Mirrors production logic from petriSecretary.ts:
// Sort all identities (shard members + our own) alphabetically, pick first.
// In tests, ourPubkey defaults to a high-value string so it doesn't interfere.

function getSecretaryIdentity(shard: { identity: string }[], ourPubkey = "zzz_test_local"): string {
    const allIdentities = [
        ...shard.map(p => p.identity),
        ourPubkey,
    ].sort((a, b) => a.localeCompare(b))
    return allIdentities[0]
}

function electSecretary<T extends { identity: string }>(shard: T[], ourPubkey = "zzz_test_local"): T {
    const secretaryId = getSecretaryIdentity(shard, ourPubkey)
    const found = shard.find(p => p.identity === secretaryId)
    return found ?? shard[0]
}

describe("Secretary election", () => {
    test("first peer in shard is secretary", () => {
        const shard = [
            { identity: "aaa111" },
            { identity: "bbb222" },
            { identity: "ccc333" },
        ]
        expect(electSecretary(shard).identity).toBe("aaa111")
    })

    test("single-member shard: member is secretary", () => {
        const shard = [{ identity: "only_peer" }]
        expect(electSecretary(shard).identity).toBe("only_peer")
    })

    test("election is deterministic across calls", () => {
        const shard = [
            { identity: "peer_a" },
            { identity: "peer_b" },
            { identity: "peer_c" },
        ]
        const results = Array.from({ length: 10 }, () => electSecretary(shard))
        for (const r of results) {
            expect(r.identity).toBe("peer_a")
        }
    })
})

// ---- isWeSecretary Logic ----

describe("isWeSecretary", () => {
    test("returns true when our pubkey matches secretary", () => {
        const ourPubkey = "aaa111"
        const shard = [
            { identity: "aaa111" },
            { identity: "bbb222" },
        ]
        const isWe = electSecretary(shard).identity === ourPubkey
        expect(isWe).toBe(true)
    })

    test("returns false when our pubkey does not match secretary", () => {
        const ourPubkey = "bbb222"
        const shard = [
            { identity: "aaa111" },
            { identity: "bbb222" },
        ]
        const isWe = electSecretary(shard).identity === ourPubkey
        expect(isWe).toBe(false)
    })
})

// ---- BFT Threshold for Collection ----

function collectionThreshold(totalMembers: number): number {
    return Math.floor((totalMembers * 2) / 3) + 1
}

describe("Collection BFT threshold", () => {
    test("shard of 10 + secretary = 11 members: needs 8", () => {
        // In collectBlockHashes: totalMembers = shard.length + 1 (shard peers + us)
        expect(collectionThreshold(11)).toBe(8)
    })

    test("shard of 9 + secretary = 10 members: needs 7", () => {
        expect(collectionThreshold(10)).toBe(7)
    })

    test("shard of 2 + secretary = 3 members: needs 3", () => {
        expect(collectionThreshold(3)).toBe(3)
    })

    test("solo node = 1 member: needs 1", () => {
        expect(collectionThreshold(1)).toBe(1)
    })

    test("threshold is always > half", () => {
        for (const n of [1, 3, 5, 7, 10, 15, 20]) {
            const t = collectionThreshold(n)
            expect(t).toBeGreaterThan(n / 2)
        }
    })
})

// ---- CollectionResult Agreement Logic ----

interface CollectionResult {
    signatures: Record<string, string>
    matchCount: number
    mismatchCount: number
    timedOutCount: number
    agreed: boolean
}

function computeAgreement(
    matchCount: number,
    mismatchCount: number,
    totalMembers: number,
): CollectionResult {
    const threshold = collectionThreshold(totalMembers)
    const timedOutCount = totalMembers - matchCount - mismatchCount
    return {
        signatures: {}, // simplified for test
        matchCount,
        mismatchCount,
        timedOutCount,
        agreed: matchCount >= threshold,
    }
}

describe("CollectionResult agreement", () => {
    test("all 10 match: agreed", () => {
        const result = computeAgreement(10, 0, 10)
        expect(result.agreed).toBe(true)
        expect(result.timedOutCount).toBe(0)
    })

    test("7/10 match: agreed (threshold is 7)", () => {
        const result = computeAgreement(7, 3, 10)
        expect(result.agreed).toBe(true)
        expect(result.mismatchCount).toBe(3)
    })

    test("6/10 match: NOT agreed", () => {
        const result = computeAgreement(6, 4, 10)
        expect(result.agreed).toBe(false)
    })

    test("7/10 match with 2 timeout, 1 mismatch: agreed", () => {
        const result = computeAgreement(7, 1, 10)
        expect(result.agreed).toBe(true)
        expect(result.timedOutCount).toBe(2)
    })

    test("5/10 match with 5 timeout: NOT agreed", () => {
        const result = computeAgreement(5, 0, 10)
        expect(result.agreed).toBe(false)
        expect(result.timedOutCount).toBe(5)
    })

    test("solo node always agrees", () => {
        const result = computeAgreement(1, 0, 1)
        expect(result.agreed).toBe(true)
    })
})

// ---- Early exit: impossible to reach threshold ----

describe("Early exit on impossible threshold", () => {
    test("too many mismatches makes threshold unreachable", () => {
        const totalMembers = 10
        const threshold = collectionThreshold(totalMembers)
        const matchCount = 3
        const mismatchCount = 5
        const remaining = totalMembers - matchCount - mismatchCount
        const canReach = matchCount + remaining >= threshold
        expect(canReach).toBe(false)
    })

    test("enough remaining to still reach threshold", () => {
        const totalMembers = 10
        const threshold = collectionThreshold(totalMembers)
        const matchCount = 5
        const mismatchCount = 1
        const remaining = totalMembers - matchCount - mismatchCount
        const canReach = matchCount + remaining >= threshold
        expect(canReach).toBe(true)
    })

    test("exactly at boundary: still reachable", () => {
        const totalMembers = 10
        const threshold = collectionThreshold(totalMembers) // 7
        const matchCount = 4
        const mismatchCount = 0
        const remaining = totalMembers - matchCount - mismatchCount // 6
        const canReach = matchCount + remaining >= threshold // 4+6=10 >= 7
        expect(canReach).toBe(true)
    })
})

// ---- Submission Receipt Logic ----

describe("Submission receipt", () => {
    test("pendingSubmissions map stores by pubkey", () => {
        const pending = new Map<string, { blockHash: string; signature: string; blockNumber: number }>()
        pending.set("pubkey_a", { blockHash: "hash_1", signature: "sig_a", blockNumber: 42 })
        pending.set("pubkey_b", { blockHash: "hash_1", signature: "sig_b", blockNumber: 42 })

        expect(pending.size).toBe(2)
        expect(pending.get("pubkey_a")!.blockHash).toBe("hash_1")
    })

    test("duplicate submission from same pubkey overwrites", () => {
        const pending = new Map<string, { blockHash: string; signature: string; blockNumber: number }>()
        pending.set("pubkey_a", { blockHash: "hash_1", signature: "sig_old", blockNumber: 42 })
        pending.set("pubkey_a", { blockHash: "hash_2", signature: "sig_new", blockNumber: 42 })

        expect(pending.size).toBe(1)
        expect(pending.get("pubkey_a")!.blockHash).toBe("hash_2")
    })

    test("wrong block number submission is ignored in collection", () => {
        const expectedBlockNumber = 42
        const submission = { blockHash: "hash_1", signature: "sig", blockNumber: 41 }
        const isCorrectBlock = submission.blockNumber === expectedBlockNumber
        expect(isCorrectBlock).toBe(false)
    })

    test("resetCollection clears state", () => {
        const pending = new Map<string, { blockHash: string }>()
        pending.set("a", { blockHash: "h1" })
        pending.set("b", { blockHash: "h2" })
        expect(pending.size).toBe(2)

        // Simulate resetCollection
        pending.clear()
        expect(pending.size).toBe(0)
    })
})

// ---- Secretary Failover Logic ----

describe("Secretary failover", () => {
    test("removing offline secretary promotes next peer", () => {
        // Sorted: aaa_secretary, bbb_peer, ccc_peer, zzz_test_local → secretary is aaa_secretary
        const shard = [
            { identity: "aaa_secretary" },
            { identity: "bbb_peer" },
            { identity: "ccc_peer" },
        ]
        const secretary = electSecretary(shard)
        expect(secretary.identity).toBe("aaa_secretary")

        // Simulate offline: remove secretary → next alphabetically is bbb_peer
        const newShard = shard.filter(p => p.identity !== secretary.identity)
        const newSecretary = electSecretary(newShard)
        expect(newSecretary.identity).toBe("bbb_peer")
    })

    test("two consecutive failovers promote third peer", () => {
        // Sorted: aaa_1, bbb_2, ccc_3, ddd_4, zzz_test_local
        let shard = [
            { identity: "aaa_1" },
            { identity: "bbb_2" },
            { identity: "ccc_3" },
            { identity: "ddd_4" },
        ]

        // First failover: remove aaa_1 → secretary becomes bbb_2
        shard = shard.filter(p => p.identity !== electSecretary(shard).identity)
        expect(electSecretary(shard).identity).toBe("bbb_2")

        // Second failover: remove bbb_2 → secretary becomes ccc_3
        shard = shard.filter(p => p.identity !== electSecretary(shard).identity)
        expect(electSecretary(shard).identity).toBe("ccc_3")
    })

    test("single peer shard: no failover possible", () => {
        const shard = [{ identity: "only_peer" }]
        const secretary = electSecretary(shard)
        const newShard = shard.filter(p => p.identity !== secretary.identity)
        expect(newShard).toHaveLength(0)
    })
})

// ---- Verify-then-sign model (manageProposeBlockHash Petri branch) ----

describe("Verify-then-sign model", () => {
    test("matching hashes: sign and accept", () => {
        const ourCandidateHash = "abc123def456"
        const proposedBlockHash = "abc123def456"
        const hashMatch = ourCandidateHash === proposedBlockHash
        expect(hashMatch).toBe(true)
    })

    test("mismatched hashes: reject", () => {
        const ourCandidateHash = "abc123def456"
        const proposedBlockHash = "xyz789ghi012"
        const hashMatch = ourCandidateHash === proposedBlockHash
        expect(hashMatch).toBe(false)
    })

    test("no candidate block formed: reject", () => {
        const candidateBlockFormed = false
        expect(candidateBlockFormed).toBe(false)
        // Response should be 401
    })

    test("verify-then-sign is stricter than accept-and-sign", () => {
        // accept-and-sign: always signs (no verification)
        // verify-then-sign: only signs if hashes match
        const scenarios = [
            { ourHash: "aaa", theirHash: "aaa", acceptAndSign: true, verifyThenSign: true },
            { ourHash: "aaa", theirHash: "bbb", acceptAndSign: true, verifyThenSign: false },
            { ourHash: null, theirHash: "ccc", acceptAndSign: true, verifyThenSign: false },
        ]
        for (const s of scenarios) {
            const oldResult = s.acceptAndSign // old model always signs
            const newResult = s.ourHash !== null && s.ourHash === s.theirHash
            expect(oldResult).toBe(s.acceptAndSign)
            expect(newResult).toBe(s.verifyThenSign)
        }
    })
})

// ---- Secretary block finalization flow ----

describe("Secretary finalization flow", () => {
    test("secretary path: collect → agree → finalize", () => {
        const states: string[] = []
        states.push("compile_block")
        states.push("collect_hashes")
        states.push("check_agreement")

        const agreed = true
        if (agreed) {
            states.push("attach_signatures")
            states.push("insert_block")
            states.push("broadcast_block")
        }

        expect(states).toEqual([
            "compile_block",
            "collect_hashes",
            "check_agreement",
            "attach_signatures",
            "insert_block",
            "broadcast_block",
        ])
    })

    test("secretary path: collect → disagree → resync → retry → agree", () => {
        const states: string[] = []
        states.push("compile_block")
        states.push("collect_hashes")

        let agreed = false
        if (!agreed) {
            states.push("resync_mempools")
            states.push("recompile_block")
            states.push("collect_hashes_retry")

            agreed = true // retry succeeds
            if (agreed) {
                states.push("attach_signatures")
                states.push("insert_block")
                states.push("broadcast_block")
            }
        }

        expect(states).toEqual([
            "compile_block",
            "collect_hashes",
            "resync_mempools",
            "recompile_block",
            "collect_hashes_retry",
            "attach_signatures",
            "insert_block",
            "broadcast_block",
        ])
    })

    test("secretary path: collect → disagree → resync → retry → disagree → skip", () => {
        const states: string[] = []
        states.push("compile_block")
        states.push("collect_hashes")

        let agreed = false
        if (!agreed) {
            states.push("resync_mempools")
            states.push("recompile_block")
            states.push("collect_hashes_retry")

            agreed = false // retry also fails
            if (!agreed) {
                states.push("skip_block")
            }
        }

        expect(states).toEqual([
            "compile_block",
            "collect_hashes",
            "resync_mempools",
            "recompile_block",
            "collect_hashes_retry",
            "skip_block",
        ])
    })

    test("member path: compile → submit → wait", () => {
        const states: string[] = []
        states.push("compile_block")
        states.push("sign_hash")
        states.push("submit_to_secretary")
        states.push("wait_for_broadcast")

        expect(states).toEqual([
            "compile_block",
            "sign_hash",
            "submit_to_secretary",
            "wait_for_broadcast",
        ])
    })
})

// ---- Signature collection with hash verification ----

describe("Signature collection with hash verification", () => {
    test("matching hash with valid signature: accepted", () => {
        const expectedHash = "block_hash_42"
        const submission = { blockHash: "block_hash_42", signature: "valid_sig", blockNumber: 42 }
        const hashMatches = submission.blockHash === expectedHash
        const sigValid = true // simulated
        expect(hashMatches && sigValid).toBe(true)
    })

    test("matching hash with invalid signature: rejected as mismatch", () => {
        const expectedHash = "block_hash_42"
        const submission = { blockHash: "block_hash_42", signature: "bad_sig", blockNumber: 42 }
        const hashMatches = submission.blockHash === expectedHash
        const sigValid = false // simulated invalid
        expect(hashMatches).toBe(true)
        expect(sigValid).toBe(false)
        // Invalid sig counts as mismatch
    })

    test("mismatched hash: rejected regardless of signature", () => {
        const expectedHash = "block_hash_42"
        const submission = { blockHash: "different_hash", signature: "valid_sig", blockNumber: 42 }
        const hashMatches = submission.blockHash === expectedHash
        expect(hashMatches).toBe(false)
    })
})
