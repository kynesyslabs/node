/**
 * Audit C3a — OmniProtocol auth must bind the payload on auth-required opcodes.
 *
 * SignatureVerifier.verify(requirePayloadBinding=true) must REJECT signature
 * modes that do not cover the payload (SIGN_PUBKEY, SIGN_MESSAGE_ID,
 * SIGN_MESSAGE_ID_TIMESTAMP) before doing any signature work, because such a
 * signature is a static replayable bearer token that authorises any payload
 * for the claimed identity. Payload-binding modes (SIGN_FULL_PAYLOAD,
 * SIGN_MESSAGE_ID_PAYLOAD_HASH) must pass the mode gate (and then be subject
 * to the normal signature check).
 *
 * The mode gate runs FIRST (before timestamp + signature), so these tests use
 * a dummy signature: a non-binding mode is rejected for the mode reason; a
 * binding mode passes the gate and fails later at signature verification — a
 * DIFFERENT error, which proves the gate did not block it.
 */

import { describe, expect, it, jest } from "@jest/globals"

// Mock the logger so importing the verifier does NOT transitively pull in
// logger -> sharedState -> chain -> datasource (TypeORM), which both slows the
// test and trips jest-haste-map on the .ccb/ agent-workspace clones.
jest.mock("@/utilities/logger", () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        debug: jest.fn(),
        warning: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        only: jest.fn(),
        custom: jest.fn(),
    },
}))

// @noble/hashes ships ESM that jest's default CJS transform can't load. The
// verifier only uses keccak inside SIGN_MESSAGE_ID_PAYLOAD_HASH's signature
// builder (which runs after the mode gate under test); a deterministic stub is
// sufficient here.
jest.mock("@noble/hashes/sha3.js", () => ({
    __esModule: true,
    keccak_256: (_input: Uint8Array) => new Uint8Array(32),
}))

import { SignatureVerifier } from "@/libs/omniprotocol/auth/verifier"
import {
    SignatureAlgorithm,
    SignatureMode,
    type AuthBlock,
} from "@/libs/omniprotocol/auth/types"
import type { OmniMessageHeader } from "@/libs/omniprotocol/types/message"

const header: OmniMessageHeader = {
    version: 1,
    opcode: 0x10,
    sequence: 1,
    payloadLength: 4,
}
const payload = Buffer.from("test")

function authWith(mode: SignatureMode): AuthBlock {
    return {
        algorithm: SignatureAlgorithm.ED25519,
        signatureMode: mode,
        timestamp: Date.now(),
        identity: Buffer.alloc(32, 1), // dummy pubkey
        signature: Buffer.alloc(64, 2), // dummy signature
    }
}

const NON_BINDING = [
    SignatureMode.SIGN_PUBKEY,
    SignatureMode.SIGN_MESSAGE_ID,
    SignatureMode.SIGN_MESSAGE_ID_TIMESTAMP,
]
const BINDING = [
    SignatureMode.SIGN_FULL_PAYLOAD,
    SignatureMode.SIGN_MESSAGE_ID_PAYLOAD_HASH,
]

describe("SignatureVerifier payload-binding enforcement (audit C3a)", () => {
    it.each(NON_BINDING)(
        "rejects non-binding mode %s when requirePayloadBinding=true",
        async mode => {
            const result = await SignatureVerifier.verify(
                authWith(mode),
                header,
                payload,
                true,
            )
            expect(result.valid).toBe(false)
            expect(result.error).toMatch(/does not bind the payload/i)
        },
    )

    it.each(BINDING)(
        "lets binding mode %s past the mode gate (fails later at signature)",
        async mode => {
            const result = await SignatureVerifier.verify(
                authWith(mode),
                header,
                payload,
                true,
            )
            // Not rejected for the binding reason — it reaches the real
            // signature check and fails there with a dummy signature.
            expect(result.valid).toBe(false)
            expect(result.error).not.toMatch(/does not bind the payload/i)
        },
    )

    it("preserves SIGN_PUBKEY when requirePayloadBinding=false (HTTP-compat path)", async () => {
        const result = await SignatureVerifier.verify(
            authWith(SignatureMode.SIGN_PUBKEY),
            header,
            payload,
            false,
        )
        // Mode gate skipped — not rejected for binding; fails later at signature.
        expect(result.error).not.toMatch(/does not bind the payload/i)
    })

    it("defaults to requiring payload binding when the flag is omitted", async () => {
        const result = await SignatureVerifier.verify(
            authWith(SignatureMode.SIGN_PUBKEY),
            header,
            payload,
        )
        expect(result.valid).toBe(false)
        expect(result.error).toMatch(/does not bind the payload/i)
    })
})
