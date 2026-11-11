import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test"

const sharedState: {
    forkConfig: Record<string, { activationHeight: number | null }>
    lastBlockNumber: number
} = {
    forkConfig: {
        tlsnProofEnforcement: { activationHeight: null },
        tlsnRecvCap: { activationHeight: 0 },
    },
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
    // The cap fork is active from block 0 unless a test says otherwise.
    sharedState.forkConfig.tlsnRecvCap = { activationHeight: 0 }
    sharedState.lastBlockNumber = 0
})

describe("TLSN revealedRecv size cap", () => {
    it("matches the upstream notary-server default cap on received data", () => {
        expect(MAX_REVEALED_RECV_BYTES).toBe(16384)
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

    it("refuses an oversized payload before hashing it", async () => {
        // Valid bytes and a correct hash, so only the size gate can refuse.
        // The hash is computed before the spy is installed.
        const claim = claimFor(
            githubResponse("victim", "1234", MAX_REVEALED_RECV_BYTES + 1),
            "victim",
            "1234",
        )
        const hashSpy = spyOn(Hashing, "sha256Bytes")
        try {
            const result = await verifyTLSNProof(claim)

            expect(result.success).toBe(false)
            expect(result.message).toContain(OVERSIZED_MESSAGE)
            expect(hashSpy).not.toHaveBeenCalled()
        } finally {
            hashSpy.mockRestore()
        }
    })

    it("reports the size refusal for an oversized payload with an out-of-range element", async () => {
        const claim = claimFor(
            new Uint8Array(MAX_REVEALED_RECV_BYTES + 1),
            "victim",
            "1234",
        ) as unknown as { revealedRecv: number[] }
        claim.revealedRecv[0] = 256

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

describe("TLSN revealedRecv size cap behind the tlsnRecvCap fork", () => {
    const H = 1000

    function oversizedClaim() {
        return claimFor(
            githubResponse("victim", "1234", MAX_REVEALED_RECV_BYTES + 1),
            "victim",
            "1234",
        )
    }

    it("does not refuse an oversized payload for its size while unscheduled", async () => {
        sharedState.forkConfig.tlsnRecvCap = { activationHeight: null }
        sharedState.lastBlockNumber = 1_000_000

        const result = await verifyTLSNProof(oversizedClaim())

        expect(result.message).not.toContain(OVERSIZED_MESSAGE)
        expect(result).toEqual({
            success: true,
            message: "Proof and recvHash verified",
            extractedUsername: "victim",
            extractedUserId: "1234",
        })
    })

    it("judges an oversized payload with an out-of-range element as a bad byte while unscheduled", async () => {
        sharedState.forkConfig.tlsnRecvCap = { activationHeight: null }
        const claim = claimFor(
            new Uint8Array(MAX_REVEALED_RECV_BYTES + 1),
            "victim",
            "1234",
        ) as unknown as { revealedRecv: number[] }
        claim.revealedRecv[0] = 256

        const result = await verifyTLSNProof(claim as never)

        expect(result).toEqual({
            success: false,
            message: "Invalid TLSN revealedRecv: expected byte array (0-255)",
        })
    })

    it("does not refuse an oversized payload for its size one block before activation", async () => {
        sharedState.forkConfig.tlsnRecvCap = { activationHeight: H }
        sharedState.lastBlockNumber = H - 1

        const result = await verifyTLSNProof(oversizedClaim())

        expect(result.message).not.toContain(OVERSIZED_MESSAGE)
        expect(result.success).toBe(true)
    })

    for (const height of [H, H + 1]) {
        it(`refuses an oversized payload before hashing it at height ${height === H ? "H" : "H+1"}`, async () => {
            sharedState.forkConfig.tlsnRecvCap = { activationHeight: H }
            sharedState.lastBlockNumber = height
            const claim = oversizedClaim()
            const hashSpy = spyOn(Hashing, "sha256Bytes")
            try {
                const result = await verifyTLSNProof(claim)

                expect(result).toEqual({
                    success: false,
                    message: `${OVERSIZED_MESSAGE} ${MAX_REVEALED_RECV_BYTES} bytes`,
                })
                expect(hashSpy).not.toHaveBeenCalled()
            } finally {
                hashSpy.mockRestore()
            }
        })
    }
})
