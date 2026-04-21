// REVIEW: Tests for GCR opcodes using JSON envelope pattern
import { describe, expect, it } from "@jest/globals"
import { readFileSync } from "fs"
import path from "path"
import {
    encodeJsonRequest,
    decodeJsonRequest,
    encodeRpcResponse,
    decodeRpcResponse,
} from "@/libs/omniprotocol/serialization/jsonEnvelope"

const fixturesDir = path.resolve(__dirname, "../../fixtures")

describe("JSON Envelope Serialization", () => {
    it("should encode and decode JSON request without data loss", () => {
        const original = {
            address:
                "0xd58e8528cd9585dab850733ee92255ae84fe28d8d44543a8e39b95cf098fd329",
            extra: "test data",
            number: 42,
        }

        const encoded = encodeJsonRequest(original)
        expect(encoded).toBeInstanceOf(Buffer)
        expect(encoded.length).toBeGreaterThan(0)

        const decoded = decodeJsonRequest<typeof original>(encoded)
        expect(decoded).toEqual(original)
    })

    it("should encode and decode RPC response without data loss", () => {
        const original = {
            result: 200,
            response: { data: "test", array: [1, 2, 3] },
            require_reply: false,
            extra: { metadata: "additional info" },
        }

        const encoded = encodeRpcResponse(original)
        expect(encoded).toBeInstanceOf(Buffer)
        expect(encoded.length).toBeGreaterThan(0)

        const decoded = decodeRpcResponse(encoded)
        expect(decoded.result).toBe(original.result)
        expect(decoded.response).toEqual(original.response)
        expect(decoded.require_reply).toBe(original.require_reply)
        expect(decoded.extra).toEqual(original.extra)
    })

    it("should handle empty extra field correctly", () => {
        const original = {
            result: 200,
            response: "success",
            require_reply: false,
            extra: null,
        }

        const encoded = encodeRpcResponse(original)
        const decoded = decodeRpcResponse(encoded)

        expect(decoded.result).toBe(200)
        expect(decoded.response).toBe("success")
        expect(decoded.extra).toBe(null)
    })
})

describe("GCR Operations - getIdentities Request", () => {
    it("should encode valid getIdentities request", () => {
        const request = {
            address:
                "0xd58e8528cd9585dab850733ee92255ae84fe28d8d44543a8e39b95cf098fd329",
        }

        const encoded = encodeJsonRequest(request)
        expect(encoded).toBeInstanceOf(Buffer)

        const decoded = decodeJsonRequest<typeof request>(encoded)
        expect(decoded.address).toBe(request.address)
    })

    it("should encode and decode identities response", () => {
        const response = {
            result: 200,
            response: {
                web2: {
                    x: [
                        {
                            proof: "https://x.com/user/status/123",
                            userId: "123456",
                            username: "testuser",
                        },
                    ],
                },
                xm: {},
                pqc: {},
            },
            require_reply: false,
            extra: null,
        }

        const encoded = encodeRpcResponse(response)
        const decoded = decodeRpcResponse(encoded)

        expect(decoded.result).toBe(200)
        expect(decoded.response).toEqual(response.response)
    })
})

describe("GCR Operations - getPoints Request", () => {
    it("should encode valid getPoints request", () => {
        const request = {
            address:
                "0xd58e8528cd9585dab850733ee92255ae84fe28d8d44543a8e39b95cf098fd329",
        }

        const encoded = encodeJsonRequest(request)
        const decoded = decodeJsonRequest<typeof request>(encoded)

        expect(decoded.address).toBe(request.address)
    })

    it("should encode and decode points response", () => {
        const response = {
            result: 200,
            response: {
                totalPoints: 150,
                breakdown: {
                    referrals: 50,
                    demosFollow: 25,
                    web3Wallets: {},
                    socialAccounts: {
                        github: 25,
                        discord: 25,
                        x: 25,
                    },
                },
                lastUpdated: "2025-11-01T12:00:00.000Z",
            },
            require_reply: false,
            extra: null,
        }

        const encoded = encodeRpcResponse(response)
        const decoded = decodeRpcResponse(encoded)

        expect(decoded.result).toBe(200)
        expect(decoded.response).toEqual(response.response)
    })
})

describe("GCR Operations - getReferralInfo Request", () => {
    it("should encode valid getReferralInfo request", () => {
        const request = {
            address:
                "0xd58e8528cd9585dab850733ee92255ae84fe28d8d44543a8e39b95cf098fd329",
        }

        const encoded = encodeJsonRequest(request)
        const decoded = decodeJsonRequest<typeof request>(encoded)

        expect(decoded.address).toBe(request.address)
    })

    it("should encode and decode referral info response", () => {
        const response = {
            result: 200,
            response: {
                referralCode: "ABC123XYZ",
                totalReferrals: 5,
                referrals: ["0x111...", "0x222..."],
                referredBy: null,
            },
            require_reply: false,
            extra: null,
        }

        const encoded = encodeRpcResponse(response)
        const decoded = decodeRpcResponse(encoded)

        expect(decoded.result).toBe(200)
        expect(decoded.response).toEqual(response.response)
    })
})

describe("GCR Operations - validateReferral Request", () => {
    it("should encode valid validateReferral request", () => {
        const request = {
            code: "ABC123XYZ",
        }

        const encoded = encodeJsonRequest(request)
        const decoded = decodeJsonRequest<typeof request>(encoded)

        expect(decoded.code).toBe(request.code)
    })

    it("should encode and decode validate response for valid code", () => {
        const response = {
            result: 200,
            response: {
                isValid: true,
                referrerPubkey:
                    "0xd58e8528cd9585dab850733ee92255ae84fe28d8d44543a8e39b95cf098fd329",
                message: "Referral code is valid",
            },
            require_reply: false,
            extra: null,
        }

        const encoded = encodeRpcResponse(response)
        const decoded = decodeRpcResponse(encoded)

        expect(decoded.result).toBe(200)
        expect(decoded.response).toEqual(response.response)
    })

    it("should encode and decode validate response for invalid code", () => {
        const response = {
            result: 200,
            response: {
                isValid: false,
                referrerPubkey: null,
                message: "Referral code is invalid",
            },
            require_reply: false,
            extra: null,
        }

        const encoded = encodeRpcResponse(response)
        const decoded = decodeRpcResponse(encoded)

        expect(decoded.result).toBe(200)
        const resp = decoded.response as {
            isValid: boolean
            referrerPubkey: string | null
            message: string
        }
        expect(resp.isValid).toBe(false)
    })
})

describe("GCR Operations - getAccountByIdentity Request", () => {
    it("should encode valid getAccountByIdentity request", () => {
        const request = {
            identity: "x:testuser",
        }

        const encoded = encodeJsonRequest(request)
        const decoded = decodeJsonRequest<typeof request>(encoded)

        expect(decoded.identity).toBe(request.identity)
    })

    it("should encode and decode account response", () => {
        const response = {
            result: 200,
            response: {
                pubkey: "0xd58e8528cd9585dab850733ee92255ae84fe28d8d44543a8e39b95cf098fd329",
                nonce: 96,
                balance: "7",
                identities: { web2: {}, xm: {}, pqc: {} },
            },
            require_reply: false,
            extra: null,
        }

        const encoded = encodeRpcResponse(response)
        const decoded = decodeRpcResponse(encoded)

        expect(decoded.result).toBe(200)
        expect(decoded.response).toEqual(response.response)
    })
})

describe("GCR Operations - getTopAccounts Request", () => {
    it("should encode and decode top accounts response", () => {
        const response = {
            result: 200,
            response: [
                {
                    pubkey: "0x111...",
                    points: 1000,
                    rank: 1,
                },
                {
                    pubkey: "0x222...",
                    points: 850,
                    rank: 2,
                },
                {
                    pubkey: "0x333...",
                    points: 750,
                    rank: 3,
                },
            ],
            require_reply: false,
            extra: null,
        }

        const encoded = encodeRpcResponse(response)
        const decoded = decodeRpcResponse(encoded)

        expect(decoded.result).toBe(200)
        expect(Array.isArray(decoded.response)).toBe(true)
        const resp = decoded.response as Array<{
            pubkey: string
            points: number
            rank: number
        }>
        expect(resp.length).toBe(3)
        expect(resp[0].rank).toBe(1)
    })
})

describe("GCR Fixture - address_info.json", () => {
    it("should have address_info fixture", () => {
        const filePath = path.join(fixturesDir, "address_info.json")
        const raw = readFileSync(filePath, "utf8")
        const fixture = JSON.parse(raw)

        expect(fixture.result).toBe(200)
        expect(fixture.response).toBeDefined()
        expect(fixture.response.pubkey).toBeDefined()
        expect(fixture.response.identities).toBeDefined()
        expect(fixture.response.points).toBeDefined()
    })

    it("should properly encode address_info fixture response", () => {
        const filePath = path.join(fixturesDir, "address_info.json")
        const raw = readFileSync(filePath, "utf8")
        const fixture = JSON.parse(raw)

        const rpcResponse = {
            result: fixture.result,
            response: fixture.response,
            require_reply: fixture.require_reply,
            extra: fixture.extra,
        }

        const encoded = encodeRpcResponse(rpcResponse)
        expect(encoded).toBeInstanceOf(Buffer)
        expect(encoded.length).toBeGreaterThan(0)

        const decoded = decodeRpcResponse(encoded)
        expect(decoded.result).toBe(200)
        expect(decoded.response).toEqual(fixture.response)
    })
})

describe("GCR Round-Trip Encoding", () => {
    it("should handle complex nested objects without data loss", () => {
        const complexRequest = {
            address:
                "0xd58e8528cd9585dab850733ee92255ae84fe28d8d44543a8e39b95cf098fd329",
            metadata: {
                nested: {
                    deeply: {
                        value: "test",
                        array: [1, 2, 3],
                        bool: true,
                    },
                },
            },
        }

        const encoded = encodeJsonRequest(complexRequest)
        const decoded = decodeJsonRequest<typeof complexRequest>(encoded)

        expect(decoded).toEqual(complexRequest)
        expect(decoded.metadata.nested.deeply.value).toBe("test")
        expect(decoded.metadata.nested.deeply.array).toEqual([1, 2, 3])
    })

    it("should handle error responses correctly", () => {
        const errorResponse = {
            result: 400,
            response: "address is required",
            require_reply: false,
            extra: { code: "VALIDATION_ERROR" },
        }

        const encoded = encodeRpcResponse(errorResponse)
        const decoded = decodeRpcResponse(encoded)

        expect(decoded.result).toBe(400)
        expect(decoded.response).toBe("address is required")
        expect(decoded.extra).toEqual({ code: "VALIDATION_ERROR" })
    })
})
