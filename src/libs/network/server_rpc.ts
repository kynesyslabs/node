/*  NOTE Importing this file automatically spawns a new server that listens for RPC requests */

import fastifyCors from "@fastify/cors"
import fastify, {
    FastifyInstance,
    FastifyReply,
    FastifyRequest,
    RouteShorthandOptions,
} from "fastify"
//import helmet from "@fastify/helmet"
import {
    BrowserRequest,
    BundleContent,
    IWeb2Payload,
    RPCRequest,
    RPCResponse,
} from "@kynesyslabs/demosdk/types"
import log from "src/utilities/logger"
import sharedState, { getSharedState } from "src/utilities/sharedState"
import Cryptography from "../crypto/cryptography"
import { PeerManager } from "../peer"
import ServerHandlers from "./endpointHandlers"
import { AuthMessage, manageAuth } from "./manageAuth"
import manageConsensusRoutines from "./manageConsensusRoutines"
import manageGCRRoutines from "./manageGCRRoutines"
import { manageExecution } from "./manageExecution"
import { HelloPeerRequest, manageHelloPeer } from "./manageHelloPeer"
import { handleLoginRequest, handleLoginResponse } from "./manageLogin"
import { manageNodeCall, NodeCall } from "./manageNodeCall"
import { registerMethodListingEndpoint } from "./methodListing"
import { handleWeb2ProxyRequest } from "./routines/transactions/handleWeb2ProxyRequest"
import { rpcSchema, setupOpenAPI } from "./openApiSpec"
import { skeletons } from "@kynesyslabs/demosdk/websdk"
import required from "src/utilities/required"
import { parseWeb2ProxyRequest } from "../utils/web2RequestUtils"

// Reading the port from sharedState

// TODO: Add Proper authentication
const noAuthMethods = ["nodeCall", "gcr_routine"]

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
function validateHeaders(headers: any): [boolean, string] {
    // Check if we have a valid signature and identity header
    log.info("[RPC Call] Validating headers...") // + JSON.stringify(headers, null, 2))
    if (!headers["signature"]) {
        log.error("[RPC Call] Missing signature header")
        return [false, "Missing signature header"]
    }
    if (!headers["identity"]) {
        log.error("[RPC Call] Missing identity header")
        return [false, "Missing identity header"]
    }
    // TODO Check if the signature is valid
    const signature = headers.signature as string
    const identity = headers.identity as string
    const message = identity
    const isValid = Cryptography.verify(message, signature, identity)
    if (!isValid) {
        log.error("[RPC Call] Invalid signature for: " + identity)
        return [false, "Invalid signature"]
    } else {
        log.info("[RPC Call] Headers are valid for: " + identity)
    }
    return [true, ""]
}

/* End of helper functions */

/* ANCHOR Processor method */
// Function to process the payload
async function processPayload(
    payload: RPCRequest,
    sender: string,
): Promise<RPCResponse> {
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
            return await manageExecution(payload.params[0] as BundleContent)
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
        case "nodeCall":
            return await manageNodeCall(payload.params[0] as NodeCall)

        // ! When things are working, we should remove the login_request and login_response methods and use a "login" method with params
        case "login_request":
            return await handleLoginRequest(payload.params[0] as BrowserRequest)
        case "login_response":
            return await handleLoginResponse(
                payload.params[0] as BrowserRequest,
            )
        /* !SECTION Possibly deprecated methods */

        case "consensus_routine": // ? Change in consensus once we have the new consensus mechanism
            return await manageConsensusRoutines(payload.params[0])

        case "gcr_routine":
            return await manageGCRRoutines(sender, payload.params[0])

        case "web2ProxyRequest": {
            const params = parseWeb2ProxyRequest(payload.params[0])

            return await handleWeb2ProxyRequest(params)
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

export default async function serverRpc(): Promise<FastifyInstance> {
    const port = getSharedState.serverPort
    const serverApp: FastifyInstance = fastify()
    await serverApp.register(fastifyCors, {
        origin: "*",
        methods: ["GET", "POST"],
    })

    // Register the method listing endpoint
    registerMethodListingEndpoint(serverApp)

    // GET request handlers

    serverApp.get("/", async (req: FastifyRequest, reply: FastifyReply) => {
        reply.header("Access-Control-Allow-Origin", "*")
        reply.send("Hello, World!")
    })

    // NOTE Generic info endpoint
    serverApp.get("/info", async (req: FastifyRequest, reply: FastifyReply) => {
        reply.header("Access-Control-Allow-Origin", "*")
        const info = await sharedState.getInstance().getInfo()
        const version = getSharedState.version
        const versionName = getSharedState.version_name
        reply.send({
            version: version,
            version_name: versionName,
            ...info,
        })
    })

    // Specific info endpoints
    serverApp.get(
        "/version",
        async (req: FastifyRequest, reply: FastifyReply) => {
            reply.header("Access-Control-Allow-Origin", "*")
            reply.send(getSharedState.version)
        },
    )
    serverApp.get(
        "/publickey",
        async (req: FastifyRequest, reply: FastifyReply) => {
            reply.header("Access-Control-Allow-Origin", "*")
            reply.send(
                getSharedState.identity.ed25519.publicKey.toString("hex"),
            )
        },
    )
    serverApp.get(
        "/connectionstring",
        async (req: FastifyRequest, reply: FastifyReply) => {
            reply.header("Access-Control-Allow-Origin", "*")
            reply.send(await getSharedState.getConnectionString())
        },
    )
    serverApp.get(
        "/peerlist",
        async (req: FastifyRequest, reply: FastifyReply) => {
            reply.header("Access-Control-Allow-Origin", "*")
            reply.send(PeerManager.getInstance().getPeers())
        },
    )

    // Get public logs (custom logs)
    serverApp.get(
        "/public_logs",
        async (req: FastifyRequest, reply: FastifyReply) => {
            reply.header("Access-Control-Allow-Origin", "*")
            reply.send(log.getPublicLogs())
        },
    )

    serverApp.get(
        "/diagnostics",
        async (req: FastifyRequest, reply: FastifyReply) => {
            reply.header("Access-Control-Allow-Origin", "*")
            reply.send(log.getDiagnostics())
        },
    )

    // Define the options for the main RPC endpoint
    const postOptions: RouteShorthandOptions = {
        schema: rpcSchema,
    }

    // Update the main RPC endpoint
    serverApp.post(
        "/",
        postOptions,
        async (req: FastifyRequest, reply: FastifyReply) => {
            log.info(
                "[RPC Call] Received request: " +
                    JSON.stringify(req.body, null, 2),
                false,
            )
            const payload = req.body as RPCRequest

            // Header check
            const headers = req.headers
            let sender = ""
            // Excluding due to noAuthMethods from header validation
            if (!noAuthMethods.includes(payload.method)) {
                const headerValidation = validateHeaders(headers)

                log.info("[RPC Call] Header validation: " + headerValidation[0])
                if (!headerValidation[0]) {
                    reply.status(401).send({
                        error: "Invalid headers:" + headerValidation[1],
                    })
                    return
                }
                sender = headers["identity"] as string
            }
            log.info("[RPC Call] Processing payload...", false)
            log.info(
                "[RPC Call] Payload: " + JSON.stringify(payload, null, 2),
                false,
            )
            // REVIEW To avoid crashes, we catch all unhandled exceptions and return a 500 error
            try {
                const response = await processPayload(payload, sender)
                log.info(
                    "[RPC Call] Response ready: sending it to the client...",
                    false,
                )
                log.info(
                    "[RPC Call] Response: " + JSON.stringify(response, null, 2),
                    false,
                )

                reply.header("Access-Control-Allow-Origin", "*")
                reply.send(response)
            } catch (error) {
                log.error("[RPC Call] Error: " + error, true)
                reply.status(500).send({
                    error: "Internal server error",
                    details: error,
                })
            }
        },
    )

    // Setup OpenAPI
    setupOpenAPI(serverApp)

    // Start the server
    await serverApp.listen({ port, host: "0.0.0.0" })
    log.info("[RPC Call] Server is running on 0.0.0.0:" + port, true)

    // Add helmet for security headers
    // await serverApp.register(helmet)

    return serverApp
}

/** NOTE
 *  REVIEW
 *  This is a Bun server implementation. It is not used yet.
 *  Hopefully, we can drop in replace the Fastify server with this one.
 *  See createServer() for an experimental smart selector of the server implementation.
 */
export async function serverRpcBun() {
    const port = getSharedState.serverPort

    // Helper to convert request to RPCRequest format
    async function parseRPCRequest(req: Request): Promise<RPCRequest | null> {
        try {
            const body = await req.json()
            if (isRPCRequest(body)) {
                return body
            }
        } catch (e) {
            return null
        }
        return null
    }

    // Helper to handle CORS headers
    const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "*",
    }

    // ? Bun should be defined
    // eslint-disable-next-line no-undef
    const server = Bun.serve({
        port: port,
        hostname: "0.0.0.0",
        async fetch(req) {
            const url = new URL(req.url)

            // Handle CORS preflight
            if (req.method === "OPTIONS") {
                return new Response(null, {
                    headers: corsHeaders,
                })
            }

            // GET endpoints
            if (req.method === "GET") {
                switch (url.pathname) {
                    case "/":
                        return new Response("Hello, World!", {
                            headers: corsHeaders,
                        })
                    case "/info":
                        var info = await sharedState.getInstance().getInfo()
                        return new Response(
                            JSON.stringify({
                                version: getSharedState.version,
                                version_name: getSharedState.version_name,
                                ...info,
                            }),
                            {
                                headers: {
                                    ...corsHeaders,
                                    "Content-Type": "application/json",
                                },
                            },
                        )
                    case "/version":
                        return new Response(
                            JSON.stringify(getSharedState.version),
                            {
                                headers: {
                                    ...corsHeaders,
                                    "Content-Type": "application/json",
                                },
                            },
                        )
                    case "/publickey":
                        return new Response(
                            JSON.stringify(
                                getSharedState.identity.ed25519.publicKey.toString(
                                    "hex",
                                ),
                            ),
                            {
                                headers: {
                                    ...corsHeaders,
                                    "Content-Type": "application/json",
                                },
                            },
                        )
                    case "/connectionstring":
                        return new Response(
                            JSON.stringify(
                                await getSharedState.getConnectionString(),
                            ),
                            {
                                headers: {
                                    ...corsHeaders,
                                    "Content-Type": "application/json",
                                },
                            },
                        )
                    case "/peerlist":
                        return new Response(
                            JSON.stringify(
                                PeerManager.getInstance().getPeers(),
                            ),
                            {
                                headers: {
                                    ...corsHeaders,
                                    "Content-Type": "application/json",
                                },
                            },
                        )
                    case "/public_logs":
                        return new Response(
                            JSON.stringify(log.getPublicLogs()),
                            {
                                headers: {
                                    ...corsHeaders,
                                    "Content-Type": "application/json",
                                },
                            },
                        )
                    case "/diagnostics":
                        return new Response(
                            JSON.stringify(log.getDiagnostics()),
                            {
                                headers: {
                                    ...corsHeaders,
                                    "Content-Type": "application/json",
                                },
                            },
                        )
                }
            }

            // Main RPC endpoint (POST /)
            if (req.method === "POST" && url.pathname === "/") {
                const payload = await parseRPCRequest(req)
                if (!payload) {
                    return new Response(
                        JSON.stringify({ error: "Invalid request format" }),
                        {
                            status: 400,
                            headers: {
                                ...corsHeaders,
                                "Content-Type": "application/json",
                            },
                        },
                    )
                }

                log.info(
                    "[RPC Call] Received request: " +
                        JSON.stringify(payload, null, 2),
                    false,
                )

                let sender = ""
                if (!noAuthMethods.includes(payload.method)) {
                    const headers = req.headers
                    const headerValidation = validateHeaders(headers)
                    if (!headerValidation[0]) {
                        return new Response(
                            JSON.stringify({
                                error: "Invalid headers:" + headerValidation[1],
                            }),
                            {
                                status: 401,
                                headers: {
                                    ...corsHeaders,
                                    "Content-Type": "application/json",
                                },
                            },
                        )
                    }
                    sender = headers.get("identity") || ""
                }

                const response = await processPayload(payload, sender)
                return new Response(JSON.stringify(response), {
                    headers: {
                        ...corsHeaders,
                        "Content-Type": "application/json",
                    },
                })
            }

            // Handle 404
            return new Response("Not Found", {
                status: 404,
                headers: corsHeaders,
            })
        },
    })

    log.info("[RPC Call] Server is running on 0.0.0.0:" + port, true)
    return server
}

// Smart server creation based on bun/node
/** Example

import { createServer } from "./libs/network/server_rpc"

// This will automatically use the appropriate server implementation
const server = await createServer()

 */
export async function createServer() {
    // Check if we're running in Bun
    const isBun =
        typeof process !== "undefined" &&
        typeof process.versions === "object" &&
        "bun" in process.versions

    if (isBun) {
        log.info("[RPC Call] Using Bun server implementation")
        return await serverRpcBun()
    } else {
        log.info("[RPC Call] Using Fastify server implementation")
        return await serverRpc()
    }
}
