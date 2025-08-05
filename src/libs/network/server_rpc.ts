/*  NOTE Importing this file automatically spawns a new server that listens for RPC requests */

//import helmet from "@fastify/helmet"
import {
    BrowserRequest,
    BundleContent,
    Ed25519SignedObject,
    RPCRequest,
    RPCResponse,
} from "@kynesyslabs/demosdk/types"
import log from "src/utilities/logger"
import sharedState, { getSharedState } from "src/utilities/sharedState"
import { PeerManager } from "../peer"
import ServerHandlers from "./endpointHandlers"
import { AuthMessage, manageAuth } from "./manageAuth"
import manageConsensusRoutines from "./manageConsensusRoutines"
import manageGCRRoutines from "./manageGCRRoutines"
import { manageExecution } from "./manageExecution"
import { HelloPeerRequest, manageHelloPeer } from "./manageHelloPeer"
import { handleLoginRequest, handleLoginResponse } from "./manageLogin"
import { manageNodeCall, NodeCall } from "./manageNodeCall"
import { handleWeb2ProxyRequest } from "./routines/transactions/handleWeb2ProxyRequest"
import { parseWeb2ProxyRequest } from "../utils/web2RequestUtils"
import manageBridges from "./manageBridge"
import { BunServer, cors, json, jsonResponse } from "./bunServer"
import { ucrypto } from "@kynesyslabs/demosdk/encryption"
import { signedObject } from "@kynesyslabs/demosdk/types"
import { hexToUint8Array } from "@kynesyslabs/demosdk/encryption"
import { bridge } from "@kynesyslabs/demosdk"
import { manageNativeBridge } from "./manageNativeBridge"
import Chain from "../blockchain/chain"
import { RateLimiter } from "./middleware/rateLimiter"
import GCR from "../blockchain/gcr/gcr"
import Telegram from "../identity/tools/telegram"
import { TelegramChallengeRequest, TelegramVerificationRequest } from "@kynesyslabs/demosdk/types"
// Reading the port from sharedState

const noAuthMethods = ["nodeCall"]

// INFO: Protected endpoints
// eslint-disable-next-line @typescript-eslint/naming-convention
const PROTECTED_ENDPOINTS = new Set([
    "rate-limit/unblock",
    "getCampaignData",
])

export const emptyResponse: RPCResponse = {
    result: 0,
    response: "",
    require_reply: false,
    extra: null,
}

// Add near the top of the file
const postSchema = {
    body: {
        type: "object",
        required: ["method", "params"],
        properties: {
            method: { type: "string" },
            params: { type: "array" },
        },
    },
}

/* Helper functions */

// Type guard to check if the payload is an RPCRequest
function isRPCRequest(obj: any): obj is RPCRequest {
    return (
        typeof obj === "object" &&
        obj !== null &&
        "method" in obj &&
        typeof obj.method === "string" &&
        "params" in obj &&
        Array.isArray(obj.params)
    )
}

// Validate the headers
async function validateHeaders(headers: Headers): Promise<[boolean, string]> {
    // Check if we have a valid signature and identity header
    if (!headers.get("signature")) {
        return [false, "Missing signature header"]
    }
    if (!headers.get("identity")) {
        log.error("[RPC Call] Missing identity header")
        return [false, "Missing identity header"]
    }
    // Check if the signature is valid
    const signature = headers.get("signature") as string
    const identity = headers.get("identity") as string
    const message = identity

    const splits = identity.split(":")

    let isValid = false
    let signatureObj: signedObject
    const supportedAlgorithms = ["ed25519", "falcon", "ml-dsa"]

    if (splits.length > 1) {
        // INFO: Handle Ed25519 signatures
        if (supportedAlgorithms.includes(splits[0])) {
            const publicKey = hexToUint8Array(splits[1])
            const _signature = hexToUint8Array(signature)

            signatureObj = {
                algorithm: splits[0],
                signature: _signature,
                message: new TextEncoder().encode(splits[1]),
                publicKey: publicKey,
            } as Ed25519SignedObject
        }

        // TODO: Handle other signature algorithms
    } else {
        signatureObj = {
            algorithm: "ed25519",
            signature: hexToUint8Array(signature),
            message: new TextEncoder().encode(message),
            publicKey: hexToUint8Array(identity),
        } as Ed25519SignedObject
    }

    if (!signatureObj) {
        log.error("[RPC Call] Invalid signature object")
        return [false, "Unsupported or malformed identity or signature header"]
    }

    isValid = await ucrypto.verify(signatureObj)

    if (isValid) {
        log.info("[RPC Call] Headers are valid for: " + identity)
        return [true, "Signature validated"]
    }

    log.error("[RPC Call] Invalid signature for: " + identity)
    return [false, "Invalid signature"]
}

/* End of helper functions */

/* ANCHOR Processor method */
// Function to process the payload
async function processPayload(
    payload: RPCRequest,
    sender: string,
): Promise<RPCResponse> {
    const splits = sender.split(":")
    if (splits.length > 1) {
        sender = splits[1]
    }


    if (PROTECTED_ENDPOINTS.has(payload.method)) {
        if (sender !== getSharedState.SUDO_PUBKEY) {
            return {
                result: 401,
                response: "Unauthorized sender",
                require_reply: false,
                extra: null,
            }
        }
    }

    // Payloads management
    switch (payload.method) {
        case "ping":
            return {
                result: 200,
                response: "pong",
                require_reply: false,
                extra: null,
            }
        case "execute":
            return await manageExecution(
                payload.params[0] as BundleContent,
                sender,
            )
        case "nativeBridge":
            /**
             * TODO & REVIEW The NativeBridgeOperation is sent to the handler to obtain a response
             * that includes the compiled operation, so that the client can generate a proper transaction
             */
            return await manageNativeBridge(
                payload.params[0] as bridge.NativeBridgeOperation,
            )
        case "hello_peer": // As it is authenticated, we can use it to check if the peer is still alive and is in our peer list
            var helloPeerRequest = payload.params[0] as HelloPeerRequest
            return await manageHelloPeer(
                helloPeerRequest as HelloPeerRequest,
                sender,
            )
        /*case "consensus":
            return await ServerHandlers.handleConsensusRequest(payload.params[0] as ConsensusRequest)
        case "proofOfConsensus":
            return await proofConsensusHandler(payload.params[0]) 
        */
        case "mempool":
            log.info(
                "[RPC Call] Received mempool merge request from: " + sender,
            )
            var res = await ServerHandlers.handleMempool(payload.params[0])
            log.info("[RPC Call] Merged mempool from: " + sender)
            log.info(JSON.stringify(res, null, 2))
            return res
        // REVIEW Peerlist merging
        case "peerlist":
            return await ServerHandlers.handlePeerlist(payload.params[0])
        // Auth management
        case "auth":
            return await manageAuth(payload.params[0] as AuthMessage)
        // NOTE Communications not requiring authentication
        case "nodeCall": {
            try {
                return await manageNodeCall(payload.params[0] as NodeCall)
            } catch (error) {
                log.error("[RPC Call] Error in nodeCall: " + error)
                return {
                    result: 500,
                    response: "Error in nodeCall: ",
                    require_reply: false,
                    extra: {
                        error: error.toString(),
                    },
                }
            }
        }

        // ! When things are working, we should remove the login_request and login_response methods and use a "login" method with params
        case "login_request":
            return await handleLoginRequest(payload.params[0] as BrowserRequest)
        case "login_response":
            return await handleLoginResponse(
                payload.params[0] as BrowserRequest,
            )
        /* !SECTION Possibly deprecated methods */

        case "consensus_routine": {
            // ? Change in consensus once we have the new consensus mechanism
            // TODO: Remove signature verification from secretary manager and manageConsensusRoutines
            // and handle the checks here - before calling manageConsensusRoutines.
            return await manageConsensusRoutines(sender, payload.params[0])
        }

        case "gcr_routine":
            return await manageGCRRoutines(sender, payload.params[0])

        case "bridge":
            return await manageBridges(sender, payload.params[0])

        case "web2ProxyRequest": {
            const params = parseWeb2ProxyRequest(payload.params[0])

            return await handleWeb2ProxyRequest(params)
        }

        case "rate-limit/unblock": {
            const ips = payload.params

            if (!Array.isArray(ips)) {
                return {
                    result: 400,
                    response: "Invalid input. Expected an array of strings.",
                    require_reply: false,
                    extra: null,
                }
            }

            const results = RateLimiter.getInstance().unblockIP(ips)

            return {
                result: 200,
                response: {
                    message: "Rate limit unblock processed",
                    results,
                },
                require_reply: false,
                extra: null,
            }
        }

        case "getCampaignData": {
            return {
                result: 200,
                response: await GCR.getCampaignData(),
                require_reply: false,
                extra: null,
            }
        }

        default:
            log.warning(
                "[RPC Call] [Received] Method not found: " + payload.method,
            )
            return {
                result: 501,
                response: "Method not implemented: " + payload.method,
                require_reply: false,
                extra: null,
            }
    }
}
/* End of processor method */

/**
 *  HTTP server using Bun
 */

export async function serverRpcBun() {
    const port = getSharedState.serverPort
    const server = new BunServer(port)

    // Initialize rate limiter with configuration from shared state
    const rateLimiter = RateLimiter.getInstance()

    // Apply middlewares
    server.use(cors())
    server.use(rateLimiter.createMiddleware())
    server.use(json())

    // GET endpoints
    // eslint-disable-next-line quotes
    server.get("/", () => new Response('{"message": "Hello, World!"}'))

    server.get("/info", async () => {
        const info = await sharedState.getInstance().getInfo()
        return jsonResponse({
            version: getSharedState.version,
            version_name: getSharedState.version_name,
            ...info,
        })
    })

    server.get("/version", () => jsonResponse(getSharedState.version))

    server.get("/publickey", () => jsonResponse(getSharedState.publicKeyHex))

    server.get("/connectionstring", async () =>
        jsonResponse(await getSharedState.getConnectionString()),
    )

    server.get("/peerlist", () =>
        jsonResponse(PeerManager.getInstance().getPeers()),
    )

    server.get("/public_logs", () => jsonResponse(log.getPublicLogs()))

    server.get("/diagnostics", () => jsonResponse(log.getDiagnostics()))

    server.get("/mcp", () => {
        return jsonResponse({
            enabled: getSharedState.isMCPServerStarted,
            transport: "sse",
            status: getSharedState.isMCPServerStarted ? "running" : "stopped",
        })
    })

    server.get("/genesis", async () => {
        const genesisBlock = await Chain.getGenesisBlock()
        let genesisData = genesisBlock.content.extra?.genesisData || null

        if (typeof genesisData === "string") {
            genesisData = JSON.parse(genesisData)
        }

        return jsonResponse(genesisData)
    })

    server.get("/rate-limit/stats", () => {
        return jsonResponse(rateLimiter.getStats())
    })

    // REVIEW: Telegram identity verification endpoints
    // Generate challenge for Telegram verification
    server.post("/api/tg-challenge", async req => {
        try {
            const payload = await req.json()
            
            // Validate request structure
            if (!payload.demos_address || typeof payload.demos_address !== "string") {
                return jsonResponse({ 
                    error: "Invalid request: demos_address is required", 
                }, 400)
            }

            const telegramTool = Telegram.getInstance()
            const challengeResponse = telegramTool.generateChallenge(payload.demos_address)
            
            return jsonResponse(challengeResponse)
        } catch (error) {
            log.error("[Telegram] Error generating challenge: " + error)
            return jsonResponse({ 
                error: "Internal error generating challenge", 
            }, 500)
        }
    })

    // Verify Telegram attestation from bot and create unsigned identity transaction
    server.post("/api/tg-verify", async req => {
        try {
            const payload = await req.json()
            
            // Validate request structure - check all required fields
            const requiredFields = ["telegram_id", "username", "signed_challenge", "timestamp", "bot_address", "bot_signature"]
            for (const field of requiredFields) {
                if (!payload[field]) {
                    return jsonResponse({ 
                        error: `Invalid request: ${field} is required`, 
                    }, 400)
                }
            }

            const telegramTool = Telegram.getInstance()
            const verificationResponse = await telegramTool.verifyAttestation(payload as TelegramVerificationRequest)
            
            // REVIEW: New flow - return unsigned transaction for user to sign
            // This follows the transaction-based pattern like Twitter identities
            if (verificationResponse.success) {
                log.info(`[Telegram] Verification successful, returning unsigned transaction for ${verificationResponse.demosAddress}`)
                
                return jsonResponse({
                    success: true,
                    message: verificationResponse.message,
                    demosAddress: verificationResponse.demosAddress,
                    telegramData: verificationResponse.telegramData,
                    unsignedTransaction: verificationResponse.unsignedTransaction,
                }, 200)
            } else {
                log.warning(`[Telegram] Verification failed: ${verificationResponse.message}`)
                
                return jsonResponse({
                    success: false,
                    message: verificationResponse.message,
                }, 400)
            }

        } catch (error) {
            log.error("[Telegram] Error verifying attestation: " + error)
            return jsonResponse({ 
                error: "Internal error verifying attestation", 
            }, 500)
        }
    })

    // Main RPC endpoint
    server.post("/", async req => {
        try {
            const ip = server.server?.requestIP(req)

            if (!ip || !ip.address) {
                return jsonResponse({ error: "IP address not found" }, 400)
            }

            const payload = await req.json()

            const rateLimitResponse = handleIdentityTxRateLimit(
                ip.address,
                payload,
                rateLimiter,
            )

            if (rateLimitResponse) {
                return rateLimitResponse
            }

            if (!isRPCRequest(payload)) {
                return jsonResponse({ error: "Invalid request format" }, 400)
            }

            log.info(
                "[RPC Call] Received request: " +
                    JSON.stringify(payload, null, 2),
                false,
            )

            let sender = ""
            if (!noAuthMethods.includes(payload.method)) {
                const headers = req.headers
                log.info(
                    "[RPC Call] Headers: " + JSON.stringify(headers, null, 2),
                    true,
                )
                const headerValidation = await validateHeaders(headers)
                console.log("headerValidation", headerValidation)
                console.log(
                    "headerValidation: " +
                        JSON.stringify(headerValidation, null, 2),
                )
                if (!headerValidation[0]) {
                    return jsonResponse(
                        { error: "Invalid headers:" + headerValidation[1] },
                        401,
                    )
                }
                sender = headers.get("identity") || ""
            }

            const response = await processPayload(payload, sender)
            return jsonResponse(response)
        } catch (e) {
            return jsonResponse({ error: "Invalid request format" }, 400)
        }
    })

    log.info("[RPC Call] Server is running on 0.0.0.0:" + port, true)
    return server.start()
}

/**
 * Rate limit identity transaction per IP address per block
 *
 * @param ip IP address of the client
 * @param payload RPC request payload
 * @param rateLimiter Rate limiter instance
 * @returns Response if rate limit is exceeded, otherwise null
 */
function handleIdentityTxRateLimit(
    ip: string,
    payload: RPCRequest,
    rateLimiter: RateLimiter,
) {
    if (rateLimiter.config.whitelistedIPs.includes(ip)) {
        return null
    }

    const ipData = rateLimiter.ipRequests.get(ip)
    if (!ipData) {
        return new Response(
            JSON.stringify({
                error: "Rate limiter: IP address not resolved",
            }),
            { status: 400 },
        )
    }

    if (payload.method !== "execute") {
        return null
    }

    if (payload.params[0].extra !== "confirmTx") {
        return null
    }

    // INFO: Exit if not an identity tx
    if (payload.params[0].data.content.data[0] !== "identity") {
        return null
    }

    if (ipData.lastSeenBlockNumber === getSharedState.lastBlockNumber) {
        ipData.lastSeenWithinBlockCount++
    } else {
        ipData.lastSeenWithinBlockCount = 1
        ipData.lastSeenBlockNumber = getSharedState.lastBlockNumber
    }

    if (ipData.lastSeenWithinBlockCount >= rateLimiter.config.txPerBlock) {
        ipData.blocked = true
        rateLimiter.ipRequests.set(ip, ipData)

        return new Response(
            JSON.stringify({
                error: "Rate limit exceeded",
                retryAfter: null,
            }),
            { status: 429 },
        )
    }

    return null
}
