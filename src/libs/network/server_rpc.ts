/*  NOTE Importing this file automatically spawns a new server that listens for RPC requests */

//import helmet from "@fastify/helmet"
import {
    BrowserRequest,
    BundleContent,
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
import { bridge } from "@kynesyslabs/demosdk"
import { manageNativeBridge } from "./manageNativeBridge"
import Chain from "../blockchain/chain"
import { RateLimiter } from "./middleware/rateLimiter"
import { getAuthContext } from "./authContext"
import GCR, { AccountParams } from "../blockchain/gcr/gcr"
// REVIEW: ZK imports for Phase 8
import { ProofVerifier } from "@/features/zk/proof/ProofVerifier"
import { MerkleTreeManager } from "@/features/zk/merkle/MerkleTreeManager"
import {
    getCurrentMerkleTreeState,
} from "@/features/zk/merkle/updateMerkleTreeAfterBlock"
import Datasource from "@/model/datasource"
import { UsedNullifier } from "@/model/entities/GCRv2/UsedNullifier"
import type { IdentityAttestationProof } from "@/features/zk/proof/ProofVerifier"

// REVIEW: ZK Merkle tree configuration constants
const ZK_MERKLE_TREE_DEPTH = 20 // Maximum tree depth for ZK proofs
const ZK_MERKLE_TREE_ID = "global" // Global tree identifier for identity attestations

// REVIEW: Singleton MerkleTreeManager instance to avoid expensive per-request initialization
let globalMerkleManager: MerkleTreeManager | null = null
// REVIEW: Initialization promise to prevent concurrent initialization race condition
let initializationPromise: Promise<MerkleTreeManager> | null = null
// REVIEW: HIGH FIX - Track initialization failures to prevent retry storms
let lastInitializationError: { timestamp: number; error: Error } | null = null
const INITIALIZATION_BACKOFF_MS = 5000 // 5 seconds
// REVIEW: Timeout for initialization to prevent indefinite hangs
const INIT_TIMEOUT_MS = 30000 // 30 seconds

/**
 * Get or create the global MerkleTreeManager singleton instance
 * Lazily initializes on first call to avoid startup overhead
 * Thread-safe: Prevents concurrent initialization with promise guard
 */
async function getMerkleTreeManager(): Promise<MerkleTreeManager> {
    // Fast path: already initialized
    if (globalMerkleManager) {
        return globalMerkleManager
    }

    // Wait for ongoing initialization
    if (initializationPromise) {
        return await initializationPromise
    }

    // REVIEW: HIGH FIX - Check if recent initialization failed and enforce backoff
    if (lastInitializationError) {
        const timeSinceError = Date.now() - lastInitializationError.timestamp
        if (timeSinceError < INITIALIZATION_BACKOFF_MS) {
            // REVIEW: Don't expose precise timing to avoid leaking information
            log.warn(
                "MerkleTreeManager initialization in backoff period",
            )
            throw new Error(
                "MerkleTreeManager initialization temporarily unavailable. Please retry shortly.",
            )
        }
        // Backoff period expired, clear error and allow retry
        lastInitializationError = null
    }

    // Start initialization with timeout protection
    // REVIEW: Wrap initialization in timeout to prevent indefinite hangs
    initializationPromise = Promise.race([
        (async () => {
            const db = await Datasource.getInstance()
            const dataSource = db.getDataSource()
            // REVIEW: Create local instance, only assign to global after successful init
            const manager = new MerkleTreeManager(
                dataSource,
                ZK_MERKLE_TREE_DEPTH,
                ZK_MERKLE_TREE_ID,
            )
            await manager.initialize()
            log.info("✅ Global MerkleTreeManager initialized")
            globalMerkleManager = manager
            return globalMerkleManager
        })(),
        new Promise<MerkleTreeManager>((_, reject) =>
            setTimeout(() => reject(new Error("Initialization timeout")), INIT_TIMEOUT_MS),
        ),
    ])

    try {
        const result = await initializationPromise
        initializationPromise = null
        return result
    } catch (error) {
        // Clear promise to allow backoff logic to run on next attempt
        initializationPromise = null
        lastInitializationError = {
            timestamp: Date.now(),
            error: error instanceof Error ? error : new Error(String(error)),
        }
        log.error("MerkleTreeManager initialization failed:", error)
        throw error
    }
}

// Reading the port from sharedState

// INFO: Protected endpoints
// eslint-disable-next-line @typescript-eslint/naming-convention
const PROTECTED_ENDPOINTS = new Set([
    "rate-limit/unblock",
    "getCampaignData",
    "awardPoints",
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

    PeerManager.getInstance().updatePeerLastSeen(sender)

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
            var res = await ServerHandlers.handleMempool(payload.params)
            log.info("[RPC Call] Merged mempool from: " + sender)
            log.info(JSON.stringify(res))
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

        case "awardPoints": {
            const awardPointsData = payload.params[0].message as AccountParams[]
            const awardedAccounts = await GCR.awardPoints(awardPointsData)

            return {
                result: 200,
                response: {
                    awardedAccounts,
                },
                require_reply: false,
                extra: null,
            }
        }

        // REVIEW: ZK proof verification endpoint for Phase 8
        case "verifyProof": {
            try {
                const attestation = payload.params[0] as IdentityAttestationProof

                if (
                    !attestation.proof ||
                    !attestation.publicSignals ||
                    !Array.isArray(attestation.publicSignals) ||
                    attestation.publicSignals.length < 2
                ) {
                    return {
                        result: 400,
                        response: "Invalid proof format: missing proof or insufficient public signals",
                        require_reply: false,
                        extra: null,
                    }
                }

                const db = await Datasource.getInstance()
                const dataSource = db.getDataSource()
                const verifier = new ProofVerifier(dataSource)

                // 1. Check if nullifier is already used
                const isUsed = await verifier.isNullifierUsed(attestation.publicSignals[0])
                if (isUsed) {
                    return {
                        result: 200, // Valid request, but nullifier used
                        response: {
                            valid: false,
                            reason: "Nullifier already used",
                            nullifier: attestation.publicSignals[0],
                            merkleRoot: attestation.publicSignals[1],
                        },
                        require_reply: false,
                        extra: null,
                    }
                }

                // 2. Verify cryptography only
                const isValid = await ProofVerifier.verifyProofOnly(
                    attestation.proof,
                    attestation.publicSignals,
                )

                return {
                    result: isValid ? 200 : 400,
                    response: {
                        valid: isValid,
                        reason: isValid ? "Valid proof" : "Invalid cryptographic proof",
                        nullifier: attestation.publicSignals[0],
                        merkleRoot: attestation.publicSignals[1],
                    },
                    require_reply: false,
                    extra: null,
                }
            } catch (error) {
                log.error("[ZK RPC] Error verifying proof:", error)
                // REVIEW: Sanitize error response - don't expose internal details
                return {
                    result: 500,
                    response: "Internal server error",
                    require_reply: false,
                    extra: null,
                }
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
    server.get("/", req => {
        const clientIP = rateLimiter.getClientIP(req, server.server)
        return new Response(
            JSON.stringify({
                message: "Hello, World!",
                yourIP: clientIP,
            }),
        )
    })

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

    // REVIEW: ZK endpoints for Phase 8
    // Get current Merkle tree root
    server.get("/zk/merkle-root", async () => {
        try {
            // REVIEW: HIGH FIX - Use singleton MerkleTreeManager for consistency
            const manager = await getMerkleTreeManager()
            const stats = manager.getStats()

            // Get current block number from database (required for response)
            const db = await Datasource.getInstance()
            const dataSource = db.getDataSource()
            const currentState = await getCurrentMerkleTreeState(dataSource)

            return jsonResponse({
                rootHash: stats.root, // From in-memory singleton (fast)
                blockNumber: currentState?.blockNumber || 0, // From database
                leafCount: stats.leafCount, // From in-memory singleton (fast)
            })
        } catch (error) {
            log.error("[ZK RPC] Error getting Merkle root:", error)
            return jsonResponse({ error: "Internal server error" }, 500)
        }
    })

    // Get Merkle proof for a commitment
    server.get("/zk/merkle/proof/:commitment", async req => {
        try {
            const commitment = req.params.commitment

            if (!commitment) {
                return jsonResponse(
                    { error: "Commitment hash required" },
                    400,
                )
            }

            // REVIEW: Input validation to prevent injection attacks
            if (!/^0x[0-9a-fA-F]{64}$/.test(commitment)) {
                return jsonResponse(
                    { error: "Invalid commitment format" },
                    400,
                )
            }

            // REVIEW: Use singleton MerkleTreeManager to avoid per-request initialization overhead
            const merkleManager = await getMerkleTreeManager()

            const proof = await merkleManager.getProofForCommitment(commitment)

            if (!proof) {
                return jsonResponse(
                    { error: "Commitment not found in Merkle tree" },
                    404,
                )
            }

            return jsonResponse({
                commitment: commitment,
                proof: {
                    siblings: proof.siblings,
                    pathIndices: proof.pathIndices,
                    root: proof.root,
                    leafIndex: proof.leafIndex,
                },
            })
        } catch (error) {
            log.error("[ZK RPC] Error getting Merkle proof:", error)
            return jsonResponse({ error: "Internal server error" }, 500)
        }
    })

    // Check if nullifier has been used
    server.get("/zk/nullifier/:hash", async req => {
        try {
            const nullifierHash = req.params.hash

            if (!nullifierHash) {
                return jsonResponse({ error: "Nullifier hash required" }, 400)
            }

            // REVIEW: Input validation to prevent injection attacks
            if (!/^0x[0-9a-fA-F]{64}$/.test(nullifierHash)) {
                return jsonResponse({ error: "Invalid nullifier hash format" }, 400)
            }

            const db = await Datasource.getInstance()
            const dataSource = db.getDataSource()
            const nullifierRepo = dataSource.getRepository(UsedNullifier)

            const nullifier = await nullifierRepo.findOne({
                where: { nullifierHash },
            })

            if (!nullifier) {
                return jsonResponse({
                    used: false,
                    nullifierHash,
                })
            }

            return jsonResponse({
                used: true,
                nullifierHash,
                blockNumber: nullifier.blockNumber,
                transactionHash: nullifier.transactionHash,
            })
        } catch (error) {
            log.error("[ZK RPC] Error checking nullifier:", error)
            return jsonResponse({ error: "Internal server error" }, 500)
        }
    })

    // Main RPC endpoint
    server.post("/", async req => {
        try {
            const clientIP = rateLimiter.getClientIP(req, server.server)

            // if (!clientIP || clientIP === "unknown") {
            //     return jsonResponse({ error: "IP address not found" }, 400)
            // }

            const payload = await req.json()

            const rateLimitResponse = handleIdentityTxRateLimit(
                clientIP,
                payload,
                rateLimiter,
            )

            if (rateLimitResponse) {
                return rateLimitResponse
            }

            if (!isRPCRequest(payload)) {
                return jsonResponse(
                    { error: "Invalid request format. Not an RPCRequest" },
                    400,
                )
            }

            log.info(
                "[RPC Call] Received request: " + JSON.stringify(payload),
                false,
            )

            const authCtx = getAuthContext(req)
            const sender = authCtx.publicKey || ""
            const response = await processPayload(payload, sender)
            return jsonResponse(response)
        } catch (e) {
            console.error("Error in serverRpcBun: " + e)
            return jsonResponse({ error: "Invalid request format" }, 400)
        }
    })

    // REVIEW: Register TLSNotary routes if enabled
    if (process.env.TLSNOTARY_ENABLED?.toLowerCase() === "true") {
        try {
            const { registerTLSNotaryRoutes } = await import(
                "@/features/tlsnotary/routes"
            )
            registerTLSNotaryRoutes(server)
        } catch (error) {
            log.warning("[RPC] Failed to register TLSNotary routes: " + error)
        }
    }

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
