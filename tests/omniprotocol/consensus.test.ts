// REVIEW: Round-trip tests for consensus opcodes using real captured fixtures
import { describe, expect, it } from "@jest/globals"
import { readFileSync, readdirSync } from "fs"
import path from "path"
import {
    decodeProposeBlockHashRequest,
    encodeProposeBlockHashResponse,
    decodeSetValidatorPhaseRequest,
    encodeSetValidatorPhaseResponse,
    decodeGreenlightRequest,
    encodeGreenlightResponse,
    ProposeBlockHashRequestPayload,
    SetValidatorPhaseRequestPayload,
    GreenlightRequestPayload,
} from "@/libs/omniprotocol/serialization/consensus"

const fixturesDir = path.resolve(__dirname, "../../fixtures/consensus")

interface ConsensusFixture {
    request: {
        method: string
        params: Array<{ method: string; params: unknown[] }>
    }
    response: {
        result: number
        response: string
        require_reply: boolean
        extra: unknown
    }
    frame_request: string
    frame_response: string
}

function loadConsensusFixture(filename: string): ConsensusFixture {
    const filePath = path.join(fixturesDir, filename)
    const raw = readFileSync(filePath, "utf8")
    return JSON.parse(raw) as ConsensusFixture
}

function getFixturesByType(method: string): string[] {
    const files = readdirSync(fixturesDir)
    return files.filter(f => f.startsWith(method) && f.endsWith(".json"))
}

describe("Consensus Fixtures - proposeBlockHash", () => {
    const fixtures = getFixturesByType("proposeBlockHash")

    it("should have proposeBlockHash fixtures", () => {
        expect(fixtures.length).toBeGreaterThan(0)
    })

    fixtures.forEach(fixtureFile => {
        it(`should decode and encode ${fixtureFile} correctly`, () => {
            const fixture = loadConsensusFixture(fixtureFile)

            // Extract request parameters from fixture
            const consensusPayload = fixture.request.params[0]
            expect(consensusPayload.method).toBe("proposeBlockHash")

            const [blockHash, validationData, proposer] =
                consensusPayload.params as [
                    string,
                    { signatures: Record<string, string> },
                    string,
                ]

            // Create request payload
            const requestPayload: ProposeBlockHashRequestPayload = {
                blockHash,
                validationData: validationData.signatures,
                proposer,
            }

            // Encode request (simulating what would be sent over wire)
            const {
                PrimitiveEncoder,
            } = require("@/libs/omniprotocol/serialization/primitives")

            // Helper to encode hex bytes
            const encodeHexBytes = (hex: string): Buffer => {
                const normalized = hex.startsWith("0x") ? hex.slice(2) : hex
                return PrimitiveEncoder.encodeBytes(
                    Buffer.from(normalized, "hex"),
                )
            }

            // Helper to encode string map
            const encodeStringMap = (map: Record<string, string>): Buffer => {
                const entries = Object.entries(map ?? {})
                const parts: Buffer[] = [
                    PrimitiveEncoder.encodeUInt16(entries.length),
                ]

                for (const [key, value] of entries) {
                    parts.push(encodeHexBytes(key))
                    parts.push(encodeHexBytes(value))
                }

                return Buffer.concat(parts)
            }

            const encodedRequest = Buffer.concat([
                encodeHexBytes(requestPayload.blockHash),
                encodeStringMap(requestPayload.validationData),
                encodeHexBytes(requestPayload.proposer),
            ])

            // Decode request (round-trip test)
            const decoded = decodeProposeBlockHashRequest(encodedRequest)

            // Verify request decode matches original (decoder adds 0x prefix)
            const normalizeHex = (hex: string) =>
                hex.toLowerCase().replace(/^0x/, "")
            expect(normalizeHex(decoded.blockHash)).toBe(
                normalizeHex(blockHash),
            )
            expect(normalizeHex(decoded.proposer)).toBe(normalizeHex(proposer))
            expect(Object.keys(decoded.validationData).length).toBe(
                Object.keys(validationData.signatures).length,
            )

            // Test response encoding
            const responsePayload = {
                status: fixture.response.result,
                voter: fixture.response.response as string,
                voteAccepted: fixture.response.result === 200,
                signatures:
                    (
                        fixture.response.extra as {
                            signatures: Record<string, string>
                        }
                    )?.signatures ?? {},
            }

            const encodedResponse =
                encodeProposeBlockHashResponse(responsePayload)
            expect(encodedResponse).toBeInstanceOf(Buffer)
            expect(encodedResponse.length).toBeGreaterThan(0)
        })
    })
})

describe("Consensus Fixtures - setValidatorPhase", () => {
    const fixtures = getFixturesByType("setValidatorPhase")

    it("should have setValidatorPhase fixtures", () => {
        expect(fixtures.length).toBeGreaterThan(0)
    })

    fixtures.forEach(fixtureFile => {
        it(`should decode and encode ${fixtureFile} correctly`, () => {
            const fixture = loadConsensusFixture(fixtureFile)

            // Extract request parameters from fixture
            const consensusPayload = fixture.request.params[0]
            expect(consensusPayload.method).toBe("setValidatorPhase")

            const [phase, seed, blockRef] = consensusPayload.params as [
                number,
                string,
                number,
            ]

            // Create request payload
            const requestPayload: SetValidatorPhaseRequestPayload = {
                phase,
                seed,
                blockRef: BigInt(blockRef),
            }

            // Encode request
            const {
                PrimitiveEncoder,
            } = require("@/libs/omniprotocol/serialization/primitives")

            const encodeHexBytes = (hex: string): Buffer => {
                const normalized = hex.startsWith("0x") ? hex.slice(2) : hex
                return PrimitiveEncoder.encodeBytes(
                    Buffer.from(normalized, "hex"),
                )
            }

            const encodedRequest = Buffer.concat([
                PrimitiveEncoder.encodeUInt8(requestPayload.phase),
                encodeHexBytes(requestPayload.seed),
                PrimitiveEncoder.encodeUInt64(requestPayload.blockRef),
            ])

            // Decode request (round-trip test)
            const decoded = decodeSetValidatorPhaseRequest(encodedRequest)

            // Verify request decode matches original (decoder adds 0x prefix)
            const normalizeHex = (hex: string) =>
                hex.toLowerCase().replace(/^0x/, "")
            expect(decoded.phase).toBe(phase)
            expect(normalizeHex(decoded.seed)).toBe(normalizeHex(seed))
            expect(Number(decoded.blockRef)).toBe(blockRef)

            // Test response encoding
            const responsePayload = {
                status: fixture.response.result,
                greenlight:
                    (fixture.response.extra as { greenlight: boolean })
                        ?.greenlight ?? false,
                timestamp: BigInt(
                    (fixture.response.extra as { timestamp: number })
                        ?.timestamp ?? 0,
                ),
                blockRef: BigInt(
                    (fixture.response.extra as { blockRef: number })
                        ?.blockRef ?? 0,
                ),
            }

            const encodedResponse =
                encodeSetValidatorPhaseResponse(responsePayload)
            expect(encodedResponse).toBeInstanceOf(Buffer)
            expect(encodedResponse.length).toBeGreaterThan(0)
        })
    })
})

describe("Consensus Fixtures - greenlight", () => {
    const fixtures = getFixturesByType("greenlight")

    it("should have greenlight fixtures", () => {
        expect(fixtures.length).toBeGreaterThan(0)
    })

    fixtures.forEach(fixtureFile => {
        it(`should decode and encode ${fixtureFile} correctly`, () => {
            const fixture = loadConsensusFixture(fixtureFile)

            // Extract request parameters from fixture
            const consensusPayload = fixture.request.params[0]
            expect(consensusPayload.method).toBe("greenlight")

            const [blockRef, timestamp, phase] = consensusPayload.params as [
                number,
                number,
                number,
            ]

            // Create request payload
            const requestPayload: GreenlightRequestPayload = {
                blockRef: BigInt(blockRef),
                timestamp: BigInt(timestamp),
                phase,
            }

            // Encode request
            const {
                PrimitiveEncoder,
            } = require("@/libs/omniprotocol/serialization/primitives")

            const encodedRequest = Buffer.concat([
                PrimitiveEncoder.encodeUInt64(requestPayload.blockRef),
                PrimitiveEncoder.encodeUInt64(requestPayload.timestamp),
                PrimitiveEncoder.encodeUInt8(requestPayload.phase),
            ])

            // Decode request (round-trip test)
            const decoded = decodeGreenlightRequest(encodedRequest)

            // Verify request decode matches original
            expect(Number(decoded.blockRef)).toBe(blockRef)
            expect(Number(decoded.timestamp)).toBe(timestamp)
            expect(decoded.phase).toBe(phase)

            // Test response encoding
            const responsePayload = {
                status: fixture.response.result,
                accepted: fixture.response.result === 200,
            }

            const encodedResponse = encodeGreenlightResponse(responsePayload)
            expect(encodedResponse).toBeInstanceOf(Buffer)
            expect(encodedResponse.length).toBeGreaterThan(0)
        })
    })
})

describe("Consensus Round-Trip Encoding", () => {
    it("proposeBlockHash should encode and decode without data loss", () => {
        const original: ProposeBlockHashRequestPayload = {
            blockHash:
                "0xabc123def456789012345678901234567890123456789012345678901234abcd",
            validationData: {
                "0x1111111111111111111111111111111111111111111111111111111111111111":
                    "0xaaaa",
                "0x2222222222222222222222222222222222222222222222222222222222222222":
                    "0xbbbb",
            },
            proposer:
                "0x3333333333333333333333333333333333333333333333333333333333333333",
        }

        const {
            PrimitiveEncoder,
        } = require("@/libs/omniprotocol/serialization/primitives")

        const encodeHexBytes = (hex: string): Buffer => {
            const normalized = hex.startsWith("0x") ? hex.slice(2) : hex
            return PrimitiveEncoder.encodeBytes(Buffer.from(normalized, "hex"))
        }

        const encodeStringMap = (map: Record<string, string>): Buffer => {
            const entries = Object.entries(map ?? {})
            const parts: Buffer[] = [
                PrimitiveEncoder.encodeUInt16(entries.length),
            ]

            for (const [key, value] of entries) {
                parts.push(encodeHexBytes(key))
                parts.push(encodeHexBytes(value))
            }

            return Buffer.concat(parts)
        }

        const encoded = Buffer.concat([
            encodeHexBytes(original.blockHash),
            encodeStringMap(original.validationData),
            encodeHexBytes(original.proposer),
        ])

        const decoded = decodeProposeBlockHashRequest(encoded)

        const normalizeHex = (hex: string) =>
            hex.toLowerCase().replace(/^0x/, "")
        expect(normalizeHex(decoded.blockHash)).toBe(
            normalizeHex(original.blockHash),
        )
        expect(normalizeHex(decoded.proposer)).toBe(
            normalizeHex(original.proposer),
        )
        expect(Object.keys(decoded.validationData).length).toBe(
            Object.keys(original.validationData).length,
        )
    })

    it("setValidatorPhase should encode and decode without data loss", () => {
        const original: SetValidatorPhaseRequestPayload = {
            phase: 2,
            seed: "0xdeadbeef",
            blockRef: 12345n,
        }

        const {
            PrimitiveEncoder,
        } = require("@/libs/omniprotocol/serialization/primitives")

        const encodeHexBytes = (hex: string): Buffer => {
            const normalized = hex.startsWith("0x") ? hex.slice(2) : hex
            return PrimitiveEncoder.encodeBytes(Buffer.from(normalized, "hex"))
        }

        const encoded = Buffer.concat([
            PrimitiveEncoder.encodeUInt8(original.phase),
            encodeHexBytes(original.seed),
            PrimitiveEncoder.encodeUInt64(original.blockRef),
        ])

        const decoded = decodeSetValidatorPhaseRequest(encoded)

        const normalizeHex = (hex: string) =>
            hex.toLowerCase().replace(/^0x/, "")
        expect(decoded.phase).toBe(original.phase)
        expect(normalizeHex(decoded.seed)).toBe(normalizeHex(original.seed))
        expect(decoded.blockRef).toBe(original.blockRef)
    })

    it("greenlight should encode and decode without data loss", () => {
        const original: GreenlightRequestPayload = {
            blockRef: 17n,
            timestamp: 1762006251n,
            phase: 1,
        }

        const {
            PrimitiveEncoder,
        } = require("@/libs/omniprotocol/serialization/primitives")

        const encoded = Buffer.concat([
            PrimitiveEncoder.encodeUInt64(original.blockRef),
            PrimitiveEncoder.encodeUInt64(original.timestamp),
            PrimitiveEncoder.encodeUInt8(original.phase),
        ])

        const decoded = decodeGreenlightRequest(encoded)

        expect(decoded.blockRef).toBe(original.blockRef)
        expect(decoded.timestamp).toBe(original.timestamp)
        expect(decoded.phase).toBe(original.phase)
    })
})
