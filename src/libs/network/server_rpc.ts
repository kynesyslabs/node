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
import { manageExecution } from "./manageExecution"
import { HelloPeerRequest, manageHelloPeer } from "./manageHelloPeer"
import { handleLoginRequest, handleLoginResponse } from "./manageLogin"
import { manageNodeCall, NodeCall } from "./manageNodeCall"
import { registerMethodListingEndpoint } from "./methodListing"
import { rpcSchema, setupOpenAPI } from "./openApiSpec"

// Reading the port from sharedState

const noAuthMethods = ["nodeCall"]

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
            return await ServerHandlers.handleMempool(payload.params[0])
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

export default async function server_rpc(): Promise<FastifyInstance> {
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
            var sender = ""
            // Excluding due to noAuthMethods from header validation
            if (!noAuthMethods.includes(payload.method)) {
                var header_validation = validateHeaders(headers)
                log.info(
                    "[RPC Call] Header validation: " + header_validation[0],
                )
                if (!header_validation[0]) {
                    reply.status(401).send({
                        error: "Invalid headers:" + header_validation[1],
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
