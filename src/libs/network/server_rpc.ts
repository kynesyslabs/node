/*  NOTE Importing this file automatically spawns a new server that listens for RPC requests */

import fastify, { FastifyInstance, FastifyRequest, FastifyReply, RouteShorthandOptions } from "fastify"
import fastifyCors from "@fastify/cors"
//import helmet from "@fastify/helmet"
import sharedState from "src/utilities/sharedState"
import { manageAuth, AuthMessage } from "./manageAuth"
import { handleLoginRequest, handleLoginResponse } from "./manageLogin"
import { manageNodeCall, NodeCall } from "./manageNodeCall"
import { manageHelloPeer, HelloPeerRequest } from "./manageHelloPeer"
import { manageExecution } from "./manageExecution"
import Cryptography from "../crypto/cryptography"
import Hashing from "../crypto/hashing"
import log from "src/utilities/logger"
import { BundleContent } from "@kynesyslabs/demosdk-http/types"
import ServerHandlers from "./endpointHandlers"
import { proofConsensusHandler } from "../consensus/routines/proofOfConsensus"
import { RPCRequest, RPCResponse, ConsensusRequest, BrowserRequest } from "@kynesyslabs/demosdk-http/types"
import manageConsensusRoutines from "./manageConsensusRoutines"
import _ from "lodash"
import { registerMethodListingEndpoint } from "./methodListing"
import { setupOpenAPI, rpcSchema } from "./openApiSpec"

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
    log.info("[RPC Call] Validating headers: " + JSON.stringify(headers, null, 2))
    if (!headers["signature"]) {
        return [false, "Missing signature header"]
    }
    if (!headers["identity"]) {
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
async function processPayload(payload: RPCRequest): Promise<RPCResponse> {
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
            return await manageHelloPeer(payload.params[0] as HelloPeerRequest)
        /*case "consensus":
            return await ServerHandlers.handleConsensusRequest(payload.params[0] as ConsensusRequest)
        case "proofOfConsensus":
            return await proofConsensusHandler(payload.params[0]) 
        */
        case "mempool":
            return await ServerHandlers.handleMempool(payload.params[0])
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
            log.warning("[RPC Call] [Received] Method not found: " + payload.method)
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
    const port = sharedState.getInstance().serverPort
    const serverApp: FastifyInstance = fastify()
    await serverApp.register(fastifyCors, {
        origin: "*",
        methods: ["GET", "POST"],
    })

    // Register the method listing endpoint
    registerMethodListingEndpoint(serverApp)

    // GET request handler
    serverApp.get("/", async (req: FastifyRequest, reply: FastifyReply) => {

        reply.header("Access-Control-Allow-Origin", "*")
        reply.send("Hello, World!")
    })

    serverApp.get("/version", async (req: FastifyRequest, reply: FastifyReply) => {
        reply.header("Access-Control-Allow-Origin", "*")
        reply.send(sharedState.getInstance().version)
    })
    serverApp.get("/publickey", async (req: FastifyRequest, reply: FastifyReply) => {
        reply.header("Access-Control-Allow-Origin", "*")
        reply.send(sharedState.getInstance().identity.ed25519.publicKey.toString("hex"))
    })

    // Setup OpenAPI
    setupOpenAPI(serverApp)

    // Define the options for the main RPC endpoint
    const postOptions: RouteShorthandOptions = {
        schema: rpcSchema,
    }

    // Update the main RPC endpoint
    serverApp.post("/", postOptions, async (req: FastifyRequest, reply: FastifyReply) => {
        log.info("[RPC Call] Received request: " + JSON.stringify(req.body, null, 2))
        const payload = req.body as RPCRequest

        // Header check
        const headers = req.headers
        // Excluding due to noAuthMethods from header validation
        if (!noAuthMethods.includes(payload.method)) {
            var header_validation = validateHeaders(headers)
            log.info("[RPC Call] Header validation: " + header_validation[0])
            if (!header_validation[0]) {
                reply.status(401).send({ error: "Invalid headers:" + header_validation[1] })
                return
            }
        }
        console.log("[RPC Call] Processing payload: " + JSON.stringify(payload, null, 2))
        const response = await processPayload(payload)
        console.log("[RPC Call] Response: " + JSON.stringify(response, null, 2))

        reply.header("Access-Control-Allow-Origin", "*")
        reply.send(response)
    })

    // Start the server
    await serverApp.listen({ port })
    console.log(`Server is running on http://localhost:${port}`)

    // Add helmet for security headers
    // await serverApp.register(helmet)

    return serverApp
}
