/**
 * Petri Consensus — block hash signing and quorum tests
 *
 * Exercises the production code (not a copy of it):
 * - manageProposeBlockHash Petri branch: verify-then-sign, secretary-only,
 *   proposer bound to the authenticated sender
 * - broadcastBlockHash: only shard members' signatures count toward quorum
 *
 * Signatures are real ed25519 signatures produced by UnifiedCrypto instances.
 */
import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import {
    UnifiedCrypto,
    hexToUint8Array,
    ucrypto,
    uint8ArrayToHex,
} from "@kynesyslabs/demosdk/encryption"

// ---- Module mocks (must be registered before the modules under test load) ----

const sharedState: Record<string, any> = {
    petriConsensus: true,
    signingAlgorithm: "ed25519",
    publicKeyHex: "",
    candidateBlock: null,
    petriConfig: { blockIntervalMs: 100 },
}
let currentShard: { identity: string; longCall?: (...args: any[]) => any }[] = []

mock.module("@/utilities/sharedState", () => ({ getSharedState: sharedState }))
mock.module("@/libs/network/server_rpc", () => ({
    emptyResponse: { result: 0, response: "", require_reply: false, extra: null },
}))
mock.module("@/libs/peer/PeerManager", () => ({
    default: { getInstance: () => ({ getPeer: () => undefined }) },
}))
mock.module("@/libs/consensus/v2/routines/getCommonValidatorSeed", () => ({
    default: async () => ({ commonValidatorSeed: "seed" }),
}))
mock.module("@/libs/consensus/v2/routines/getShard", () => ({
    default: async () => currentShard,
}))
mock.module("@/libs/consensus/v2/routines/ensureCandidateBlockFormed", () => ({
    default: async () => !!sharedState.candidateBlock,
}))
mock.module("@/libs/consensus/v2/routines/mergeMempools", () => ({
    mergeMempools: async () => undefined,
}))
mock.module("@/libs/blockchain/mempool_v2", () => ({
    default: { getMempool: async () => [] },
}))

const { default: manageProposeBlockHash } = await import(
    "@/libs/consensus/v2/routines/manageProposeBlockHash"
)
const { broadcastBlockHash } = await import(
    "@/libs/consensus/v2/routines/broadcastBlockHash"
)

// ---- Keys ----

interface Key {
    crypto: UnifiedCrypto
    id: string
}

async function makeKey(name: string, fill: number): Promise<Key> {
    const crypto = UnifiedCrypto.getInstance(name)
    await crypto.generateIdentity("ed25519", new Uint8Array(32).fill(fill))
    const { publicKey } = await crypto.getIdentity("ed25519")
    return { crypto, id: uint8ArrayToHex(publicKey as Uint8Array) }
}

async function signWith(key: Key, hash: string): Promise<string> {
    const signed = await key.crypto.sign("ed25519", new TextEncoder().encode(hash))
    return uint8ArrayToHex(signed.signature)
}

async function verify(id: string, hash: string, signature: string) {
    return ucrypto.verify({
        algorithm: "ed25519",
        message: new TextEncoder().encode(hash),
        signature: hexToUint8Array(signature),
        publicKey: hexToUint8Array(id),
    })
}

let us: Key
let peerA: Key
let peerB: Key
let outsider1: Key
let outsider2: Key

beforeAll(async () => {
    // Local node identity is the default ucrypto instance used by production code
    await ucrypto.generateIdentity("ed25519", new Uint8Array(32).fill(6))
    const { publicKey } = await ucrypto.getIdentity("ed25519")
    us = { crypto: ucrypto as unknown as UnifiedCrypto, id: uint8ArrayToHex(publicKey as Uint8Array) }
    peerA = await makeKey("petri-test-peer-a", 2)
    peerB = await makeKey("petri-test-peer-b", 3)
    outsider1 = await makeKey("petri-test-outsider-1", 4)
    outsider2 = await makeKey("petri-test-outsider-2", 5)
    sharedState.publicKeyHex = us.id
    // The fixed seeds make a shard peer (not us) the elected secretary, so a
    // remote proposer can be the legitimate secretary in these tests.
    const lowest = [us.id, peerA.id, peerB.id].sort((a, b) => a.localeCompare(b))[0]
    if (lowest === us.id) throw new Error("test setup: local node must not be the secretary")
})

function electedSecretaryId(): string {
    // Lowest identity among shard + us (petriSecretary election)
    return [us.id, ...currentShard.map(p => p.identity)].sort((a, b) => a.localeCompare(b))[0]
}

async function candidate(hash: string) {
    return { hash, validation_data: { signatures: { [us.id]: await signWith(us, hash) } } }
}

// ---- manageProposeBlockHash (Petri branch) ----

describe("manageProposeBlockHash with Petri active", () => {
    beforeEach(() => {
        sharedState.petriConsensus = true
        currentShard = [{ identity: peerA.id }, { identity: peerB.id }]
    })

    test("secretary proposes a hash that differs from our candidate: refuse, no signature", async () => {
        const secretaryId = electedSecretaryId()
        sharedState.candidateBlock = await candidate("our-candidate-hash")
        const res = await manageProposeBlockHash(
            "attacker-chosen-hash",
            { signatures: {} } as any,
            secretaryId,
            secretaryId,
        )
        expect(res.result).toBe(401)
        expect(JSON.stringify(res.extra ?? "")).not.toContain("signatures")
    })

    test("non-secretary shard member proposes our own candidate hash: refuse", async () => {
        const secretaryId = electedSecretaryId()
        const nonSecretary = [peerA, peerB].find(k => k.id !== secretaryId) as Key
        sharedState.candidateBlock = await candidate("same-hash")
        const res = await manageProposeBlockHash(
            "same-hash",
            { signatures: {} } as any,
            nonSecretary.id,
            nonSecretary.id,
        )
        expect(res.result).toBe(401)
        expect(res.extra).toBe("Proposer is not the elected secretary")
    })

    test("claimed proposer differs from authenticated sender: refuse", async () => {
        const secretaryId = electedSecretaryId()
        sharedState.candidateBlock = await candidate("same-hash")
        const res = await manageProposeBlockHash(
            "same-hash",
            { signatures: {} } as any,
            secretaryId,
            outsider1.id,
        )
        expect(res.result).toBe(401)
        expect(res.extra).toBe("Proposer does not match authenticated sender")
    })

    test("no candidate block formed: refuse", async () => {
        const secretaryId = electedSecretaryId()
        sharedState.candidateBlock = null
        const res = await manageProposeBlockHash(
            "any-hash",
            { signatures: {} } as any,
            secretaryId,
            secretaryId,
        )
        expect(res.result).toBe(401)
        expect(res.extra).toBe("Candidate block not formed")
    })

    test("secretary proposes our own candidate hash: sign it with a valid signature", async () => {
        const secretaryId = electedSecretaryId()
        sharedState.candidateBlock = await candidate("matching-hash")
        const res = await manageProposeBlockHash(
            "matching-hash",
            { signatures: {} } as any,
            secretaryId,
            secretaryId,
        )
        expect(res.result).toBe(200)
        const sig = (res.extra as any).signatures[us.id]
        expect(typeof sig).toBe("string")
        expect(await verify(us.id, "matching-hash", sig)).toBe(true)
    })
})

// ---- broadcastBlockHash quorum accounting ----

describe("broadcastBlockHash quorum accounting", () => {
    test("signatures from keys outside the shard are not counted", async () => {
        const hash = "block-hash-for-quorum"
        const block: any = {
            hash,
            validation_data: { signatures: { [us.id]: await signWith(us, hash) } },
        }
        // peerA responds honestly, then pads its response with two valid
        // signatures over the same hash from keys that are not in the shard.
        const paddedResponse = {
            result: 200,
            response: peerA.id,
            extra: {
                signatures: {
                    [peerA.id]: await signWith(peerA, hash),
                    [outsider1.id]: await signWith(outsider1, hash),
                    [outsider2.id]: await signWith(outsider2, hash),
                },
            },
        }
        const shard: any[] = [
            { identity: peerA.id, longCall: async () => paddedResponse },
            { identity: peerB.id, longCall: async () => ({ result: 401, response: peerB.id, extra: "no" }) },
        ]

        const [signatureCount] = await broadcastBlockHash(block, shard)

        expect(Object.keys(block.validation_data.signatures).sort()).toEqual(
            [us.id, peerA.id].sort(),
        )
        expect(signatureCount).toBe(2)
    })
})
