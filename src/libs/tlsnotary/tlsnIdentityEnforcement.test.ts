const sharedState: {
    forkConfig: Record<string, { activationHeight: number | null }>
    lastBlockNumber: number
} = {
    forkConfig: { tlsnProofEnforcement: { activationHeight: 0 } },
    lastBlockNumber: 0,
}

jest.mock("@/utilities/sharedState", () => ({ getSharedState: sharedState }))

jest.mock("@/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        only: jest.fn(),
    },
}))

import { verifyTLSNProof } from "./verifier"
import Hashing from "@/libs/crypto/hashing"

/**
 * A claim an attacker can build without touching GitHub: the "proof" is a hex
 * blob the node only shape-checks, and every other field is authored by the
 * same caller — `recvHash` is just the hash of the bytes they wrote.
 */
function forgedClaim(username: string, userId: string) {
    const body = JSON.stringify({ login: username, id: Number(userId) })
    const recv = new TextEncoder().encode(
        `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n${body}`,
    )
    return {
        context: "github",
        proof: { version: "0.1.0-alpha.12", data: "ab".repeat(200) },
        recvHash: Hashing.sha256Bytes(recv),
        revealedRecv: Array.from(recv),
        username,
        userId,
    } as never
}

beforeEach(() => {
    sharedState.forkConfig.tlsnProofEnforcement = { activationHeight: 0 }
    sharedState.lastBlockNumber = 0
})

describe("TLSNotary identity claims", () => {
    it("are refused while the node cannot verify the notary signature", async () => {
        const result = await verifyTLSNProof(forgedClaim("victim", "1234"))

        expect(result.success).toBe(false)
        expect(result.message).toContain("no evidence beyond its own bytes")
    })

    it("refuses a claim on any handle, not just a specific one", async () => {
        const result = await verifyTLSNProof(forgedClaim("someone-else", "99"))

        expect(result.success).toBe(false)
    })

    it("keeps the legacy behaviour where the fork is not scheduled", async () => {
        // Test networks that depend on structure-only proofs leave the fork
        // unscheduled; the claim then passes on its self-consistency alone,
        // which is exactly what the fork exists to stop elsewhere.
        sharedState.forkConfig.tlsnProofEnforcement = { activationHeight: null }

        const result = await verifyTLSNProof(forgedClaim("victim", "1234"))

        expect(result.success).toBe(true)
    })

    it("still rejects a claim whose hash does not match its own bytes", async () => {
        sharedState.forkConfig.tlsnProofEnforcement = { activationHeight: null }
        const claim = forgedClaim("victim", "1234") as unknown as {
            recvHash: string
        }
        claim.recvHash = "00".repeat(32)

        const result = await verifyTLSNProof(claim as never)

        expect(result.success).toBe(false)
        expect(result.message).toContain("recvHash mismatch")
    })
})
