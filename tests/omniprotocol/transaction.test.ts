// REVIEW: Tests for transaction opcodes using JSON envelope pattern
import { describe, expect, it } from "@jest/globals"
import {
    encodeJsonRequest,
    decodeJsonRequest,
    encodeRpcResponse,
    decodeRpcResponse,
} from "@/libs/omniprotocol/serialization/jsonEnvelope"

describe("Transaction Operations - Execute Request (0x10)", () => {
    it("should encode valid execute request with confirmTx", () => {
        const request = {
            content: {
                type: "transaction",
                data: {
                    from: "0xd58e8528cd9585dab850733ee92255ae84fe28d8d44543a8e39b95cf098fd329",
                    to: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
                    amount: "1000000000000000000",
                    nonce: 5,
                },
                extra: "confirmTx",
            },
        }

        const encoded = encodeJsonRequest(request)
        expect(encoded).toBeInstanceOf(Buffer)

        const decoded = decodeJsonRequest<typeof request>(encoded)
        expect(decoded.content).toEqual(request.content)
        expect(decoded.content.extra).toBe("confirmTx")
    })

    it("should encode valid execute request with broadcastTx", () => {
        const request = {
            content: {
                type: "transaction",
                data: {
                    from: "0xd58e8528cd9585dab850733ee92255ae84fe28d8d44543a8e39b95cf098fd329",
                    to: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
                    amount: "5000000000000000000",
                    nonce: 6,
                },
                extra: "broadcastTx",
            },
        }

        const encoded = encodeJsonRequest(request)
        const decoded = decodeJsonRequest<typeof request>(encoded)

        expect(decoded.content.extra).toBe("broadcastTx")
        expect(decoded.content.data).toEqual(request.content.data)
    })

    it("should encode and decode execute success response", () => {
        const response = {
            result: 200,
            response: {
                validityData: {
                    isValid: true,
                    gasConsumed: 21000,
                    signature: "0xabcd...",
                },
            },
            require_reply: false,
            extra: null,
        }

        const encoded = encodeRpcResponse(response)
        const decoded = decodeRpcResponse(encoded)

        expect(decoded.result).toBe(200)
        expect(decoded.response).toEqual(response.response)
    })

    it("should encode and decode execute error response", () => {
        const response = {
            result: 400,
            response: "Insufficient balance",
            require_reply: false,
            extra: { code: "INSUFFICIENT_BALANCE" },
        }

        const encoded = encodeRpcResponse(response)
        const decoded = decodeRpcResponse(encoded)

        expect(decoded.result).toBe(400)
        expect(decoded.response).toBe("Insufficient balance")
        expect(decoded.extra).toEqual({ code: "INSUFFICIENT_BALANCE" })
    })
})

describe("Transaction Operations - NativeBridge Request (0x11)", () => {
    it("should encode valid nativeBridge request", () => {
        const request = {
            operation: {
                type: "bridge",
                sourceChain: "ethereum",
                targetChain: "demos",
                asset: "ETH",
                amount: "1000000000000000000",
                recipient:
                    "0xd58e8528cd9585dab850733ee92255ae84fe28d8d44543a8e39b95cf098fd329",
            },
        }

        const encoded = encodeJsonRequest(request)
        expect(encoded).toBeInstanceOf(Buffer)

        const decoded = decodeJsonRequest<typeof request>(encoded)
        expect(decoded.operation).toEqual(request.operation)
    })

    it("should encode and decode nativeBridge success response", () => {
        const response = {
            result: 200,
            response: {
                content: {
                    bridgeId: "bridge_123",
                    estimatedTime: 300,
                    fee: "50000000000000000",
                },
                signature: "0xdef...",
                rpc: "node1.demos.network",
            },
            require_reply: false,
            extra: null,
        }

        const encoded = encodeRpcResponse(response)
        const decoded = decodeRpcResponse(encoded)

        expect(decoded.result).toBe(200)
        expect(decoded.response).toEqual(response.response)
    })

    it("should encode and decode nativeBridge error response", () => {
        const response = {
            result: 400,
            response: "Unsupported chain",
            require_reply: false,
            extra: { code: "UNSUPPORTED_CHAIN" },
        }

        const encoded = encodeRpcResponse(response)
        const decoded = decodeRpcResponse(encoded)

        expect(decoded.result).toBe(400)
        expect(decoded.response).toBe("Unsupported chain")
    })
})

describe("Transaction Operations - Bridge Request (0x12)", () => {
    it("should encode valid bridge get_trade request", () => {
        const request = {
            method: "get_trade",
            params: [
                {
                    fromChain: "ethereum",
                    toChain: "polygon",
                    fromToken: "ETH",
                    toToken: "MATIC",
                    amount: "1000000000000000000",
                },
            ],
        }

        const encoded = encodeJsonRequest(request)
        const decoded = decodeJsonRequest<typeof request>(encoded)

        expect(decoded.method).toBe("get_trade")
        expect(decoded.params).toEqual(request.params)
    })

    it("should encode valid bridge execute_trade request", () => {
        const request = {
            method: "execute_trade",
            params: [
                {
                    tradeId: "trade_456",
                    fromAddress:
                        "0xd58e8528cd9585dab850733ee92255ae84fe28d8d44543a8e39b95cf098fd329",
                    slippage: 0.5,
                },
            ],
        }

        const encoded = encodeJsonRequest(request)
        const decoded = decodeJsonRequest<typeof request>(encoded)

        expect(decoded.method).toBe("execute_trade")
        expect(decoded.params[0]).toHaveProperty("tradeId", "trade_456")
    })

    it("should encode and decode bridge get_trade response", () => {
        const response = {
            result: 200,
            response: {
                quote: {
                    estimatedAmount: "2500000000000000000",
                    route: ["ethereum", "polygon"],
                    fee: "10000000000000000",
                    priceImpact: 0.1,
                },
            },
            require_reply: false,
            extra: null,
        }

        const encoded = encodeRpcResponse(response)
        const decoded = decodeRpcResponse(encoded)

        expect(decoded.result).toBe(200)
        expect(decoded.response).toEqual(response.response)
    })

    it("should encode and decode bridge execute_trade response", () => {
        const response = {
            result: 200,
            response: {
                txHash: "0x123abc...",
                status: "pending",
                estimatedCompletion: 180,
            },
            require_reply: false,
            extra: null,
        }

        const encoded = encodeRpcResponse(response)
        const decoded = decodeRpcResponse(encoded)

        expect(decoded.result).toBe(200)
        const resp = decoded.response as {
            txHash: string
            status: string
            estimatedCompletion: number
        }
        expect(resp.status).toBe("pending")
    })
})

describe("Transaction Operations - Broadcast Request (0x16)", () => {
    it("should encode valid broadcast request", () => {
        const request = {
            content: {
                type: "transaction",
                data: {
                    from: "0xd58e8528cd9585dab850733ee92255ae84fe28d8d44543a8e39b95cf098fd329",
                    to: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
                    amount: "2000000000000000000",
                    nonce: 7,
                },
                extra: "broadcastTx",
            },
        }

        const encoded = encodeJsonRequest(request)
        const decoded = decodeJsonRequest<typeof request>(encoded)

        expect(decoded.content.extra).toBe("broadcastTx")
        expect(decoded.content.data).toEqual(request.content.data)
    })

    it("should encode and decode broadcast success response", () => {
        const response = {
            result: 200,
            response: {
                txHash: "0xabc123...",
                mempoolStatus: "added",
                propagationNodes: 15,
            },
            require_reply: false,
            extra: null,
        }

        const encoded = encodeRpcResponse(response)
        const decoded = decodeRpcResponse(encoded)

        expect(decoded.result).toBe(200)
        expect(decoded.response).toEqual(response.response)
    })

    it("should encode and decode broadcast error response", () => {
        const response = {
            result: 400,
            response: "Transaction already in mempool",
            require_reply: false,
            extra: { code: "DUPLICATE_TX" },
        }

        const encoded = encodeRpcResponse(response)
        const decoded = decodeRpcResponse(encoded)

        expect(decoded.result).toBe(400)
        expect(decoded.response).toBe("Transaction already in mempool")
    })
})

describe("Transaction Operations - Confirm Request (0x15)", () => {
    it("should encode valid confirm request", () => {
        const request = {
            transaction: {
                hash: "0xabc123...",
                content: {
                    type: "native",
                    from: "0xd58e8528cd9585dab850733ee92255ae84fe28d8d44543a8e39b95cf098fd329",
                    to: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
                    amount: "1000000000000000000",
                    nonce: 5,
                    gcr_edits: [],
                    data: [],
                },
            },
        }

        const encoded = encodeJsonRequest(request)
        expect(encoded).toBeInstanceOf(Buffer)

        const decoded = decodeJsonRequest<typeof request>(encoded)
        expect(decoded.transaction).toEqual(request.transaction)
    })

    it("should encode and decode confirm success response with ValidityData", () => {
        const response = {
            result: 200,
            response: {
                data: {
                    valid: true,
                    reference_block: 12345,
                    message: "Transaction is valid",
                    gas_operation: {
                        gasConsumed: 21000,
                        gasPrice: "1000000000",
                        totalCost: "21000000000000",
                    },
                    transaction: {
                        hash: "0xabc123...",
                        blockNumber: 12346,
                    },
                },
                signature: {
                    type: "ed25519",
                    data: "0xdef456...",
                },
                rpc_public_key: {
                    type: "ed25519",
                    data: "0x789ghi...",
                },
            },
            require_reply: false,
            extra: null,
        }

        const encoded = encodeRpcResponse(response)
        const decoded = decodeRpcResponse(encoded)

        expect(decoded.result).toBe(200)
        expect(decoded.response).toEqual(response.response)
    })

    it("should encode and decode confirm failure response with invalid transaction", () => {
        const response = {
            result: 200,
            response: {
                data: {
                    valid: false,
                    reference_block: null,
                    message: "Insufficient balance for gas",
                    gas_operation: null,
                    transaction: null,
                },
                signature: {
                    type: "ed25519",
                    data: "0xdef456...",
                },
                rpc_public_key: null,
            },
            require_reply: false,
            extra: null,
        }

        const encoded = encodeRpcResponse(response)
        const decoded = decodeRpcResponse(encoded)

        expect(decoded.result).toBe(200)
        const resp = decoded.response as {
            data: { valid: boolean; message: string }
        }
        expect(resp.data.valid).toBe(false)
        expect(resp.data.message).toBe("Insufficient balance for gas")
    })

    it("should handle missing transaction field in confirm request", () => {
        const request = {}

        const encoded = encodeJsonRequest(request)
        const decoded = decodeJsonRequest<typeof request>(encoded)

        expect(decoded).toEqual(request)
    })
})

describe("Transaction Round-Trip Encoding", () => {
    it("should handle complex execute request without data loss", () => {
        const complexRequest = {
            content: {
                type: "transaction",
                data: {
                    from: "0xd58e8528cd9585dab850733ee92255ae84fe28d8d44543a8e39b95cf098fd329",
                    to: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
                    amount: "3000000000000000000",
                    nonce: 8,
                    metadata: {
                        nested: {
                            deeply: {
                                value: "test",
                                array: [1, 2, 3],
                            },
                        },
                    },
                },
                extra: "confirmTx",
            },
        }

        const encoded = encodeJsonRequest(complexRequest)
        const decoded = decodeJsonRequest<typeof complexRequest>(encoded)

        expect(decoded).toEqual(complexRequest)
        expect(decoded.content.data.metadata.nested.deeply.value).toBe("test")
    })

    it("should handle missing params in bridge request", () => {
        const request = {
            method: "get_trade",
            params: [],
        }

        const encoded = encodeJsonRequest(request)
        const decoded = decodeJsonRequest<typeof request>(encoded)

        expect(decoded.method).toBe("get_trade")
        expect(decoded.params).toEqual([])
    })

    it("should handle validation error responses correctly", () => {
        const errorResponse = {
            result: 400,
            response: "content is required",
            require_reply: false,
            extra: { code: "VALIDATION_ERROR" },
        }

        const encoded = encodeRpcResponse(errorResponse)
        const decoded = decodeRpcResponse(encoded)

        expect(decoded.result).toBe(400)
        expect(decoded.response).toBe("content is required")
        expect(decoded.extra).toEqual({ code: "VALIDATION_ERROR" })
    })
})
