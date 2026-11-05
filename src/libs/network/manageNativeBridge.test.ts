/**
 * The native bridge has no signing behind it yet. Answering 200 with an
 * unsigned "compiled operation" invites a client to act on it; the call
 * says it is not implemented instead.
 */

import { describe, expect, it, mock } from "bun:test"

mock.module("@/utilities/sharedState", () => ({
    getSharedState: { identity: { ed25519_hex: { publicKey: "0xnode" } } },
}))

const { manageNativeBridge } = await import("./manageNativeBridge")

describe("manageNativeBridge", () => {
    it("answers 501 and hands out no operation", async () => {
        for (const originChainType of ["EVM", "SOLANA"]) {
            const reply = await manageNativeBridge({ originChainType } as any)
            expect(reply.result).toBe(501)
            expect(JSON.stringify(reply.response)).not.toContain("signature")
        }
    })
})
