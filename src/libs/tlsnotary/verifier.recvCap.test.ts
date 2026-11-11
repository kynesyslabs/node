import { beforeEach, describe, expect, it, mock } from "bun:test"

const sharedState: {
    forkConfig: Record<string, { activationHeight: number | null }>
    lastBlockNumber: number
} = {
    forkConfig: { tlsnProofEnforcement: { activationHeight: null } },
    lastBlockNumber: 0,
}

mock.module("@/utilities/sharedState", () => ({ getSharedState: sharedState }))

mock.module("@/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: mock(),
        info: mock(),
        warn: mock(),
        warning: mock(),
        error: mock(),
        only: mock(),
    },
}))

import { MAX_REVEALED_RECV_BYTES, verifyTLSNProof } from "./verifier"
import Hashing from "@/libs/crypto/hashing"

const OVERSIZED_MESSAGE = "Invalid TLSN revealedRecv: payload exceeds"

function claimFor(recv: Uint8Array, username: string, userId: string) {
    return {
        context: "github",
        proof: { version: "0.1.0-alpha.12", data: "ab".repeat(200) },
        recvHash: Hashing.sha256Bytes(recv),
        revealedRecv: Array.from(recv),
        username,
        userId,
    } as never
}

/** A GitHub /user response, padded with trailing whitespace to `size` bytes. */
function githubResponse(username: string, userId: string, size?: number) {
    const head =
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n" +
        JSON.stringify({ login: username, id: Number(userId) })
    const padded = size === undefined ? head : head.padEnd(size, " ")
    return new TextEncoder().encode(padded)
}

beforeEach(() => {
    // The enforcement fork refuses every claim before revealedRecv is read,
    // so it stays unscheduled here to reach the decoding path.
    sharedState.forkConfig.tlsnProofEnforcement = { activationHeight: null }
    sharedState.lastBlockNumber = 0
})

describe("TLSN revealedRecv size cap", () => {
    it("matches the notary's default cap on received data", () => {
        expect(MAX_REVEALED_RECV_BYTES).toBe(65536)
    })

    it("uses the mocked shared state (fork refusal when scheduled)", async () => {
        sharedState.forkConfig.tlsnProofEnforcement = { activationHeight: 0 }

        const result = await verifyTLSNProof(
            claimFor(githubResponse("victim", "1234"), "victim", "1234"),
        )

        expect(result.success).toBe(false)
        expect(result.message).toContain("no evidence beyond its own bytes")
    })

    it("refuses a payload one byte over the cap before scanning it", async () => {
        // Unbalanced brackets are the worst case for the JSON scans; with a
        // correct hash, only the size gate stands between them and the scan.
        const recv = new Uint8Array(MAX_REVEALED_RECV_BYTES + 1).fill(
            "[".charCodeAt(0),
        )

        const result = await verifyTLSNProof(claimFor(recv, "victim", "1234"))

        expect(result.success).toBe(false)
        expect(result.message).toContain(OVERSIZED_MESSAGE)
    })

    it("refuses an oversized payload before element checks and hashing", async () => {
        const claim = claimFor(
            new Uint8Array(MAX_REVEALED_RECV_BYTES + 1),
            "victim",
            "1234",
        ) as unknown as { revealedRecv: number[]; recvHash: string }
        claim.revealedRecv[0] = 256
        claim.recvHash = "00".repeat(32)

        const result = await verifyTLSNProof(claim as never)

        expect(result.success).toBe(false)
        expect(result.message).toContain(OVERSIZED_MESSAGE)
    })

    it("does not refuse a payload exactly at the cap for its size", async () => {
        const recv = githubResponse("victim", "1234", MAX_REVEALED_RECV_BYTES)
        expect(recv.length).toBe(MAX_REVEALED_RECV_BYTES)

        const result = await verifyTLSNProof(claimFor(recv, "victim", "1234"))

        expect(result.message).not.toContain(OVERSIZED_MESSAGE)
        expect(result.success).toBe(true)
    })

    it("still verifies a normal small payload", async () => {
        const result = await verifyTLSNProof(
            claimFor(githubResponse("victim", "1234"), "victim", "1234"),
        )

        expect(result).toEqual({
            success: true,
            message: "Proof and recvHash verified",
            extractedUsername: "victim",
            extractedUserId: "1234",
        })
    })
})
