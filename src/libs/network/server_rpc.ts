/*  NOTE Importing this file automatically spawns a new server that listens for RPC requests */

import express, { Request, Response, Express } from "express"
import sharedState from "src/utilities/sharedState"
import { manageAuth, AuthMessage } from "./manageAuth"
import { manageVote, VoteRequest } from "./manageVote"
import { handleLoginRequest, handleLoginResponse } from "./manageLogin"
import { manageNodeCall, NodeCall } from "./manageNodeCall"
import { manageHelloPeer, HelloPeerRequest } from "./manageHelloPeer"
import { manageExecution } from "./manageExecution"
import Cryptography from "../crypto/cryptography"
import Hashing from "../crypto/hashing"
import log from "src/utilities/logger"
import { BundleContent } from "@kynesyslabs/demosdk/types"
import ServerHandlers from "./endpointHandlers"
import { proofConsensusHandler } from "../consensus/routines/proofOfConsensus"

// ANCHOR BrowserRequest
export const emptyResponse: RPCResponse = {
    result: 0,
    response: true,
    require_reply: false,
    extra: null,
}

// Reading the port from sharedState
const port = sharedState.getInstance().serverPort

const noAuthMethods = ["nodeCall"]

/* Interface definitions */
export interface RPCRequest {
    method: string
    params: any[]
}

export interface RPCResponse {
    result: number // HTTP status code
    response: any
    require_reply: boolean
    extra: any
}

export interface BrowserRequest {
    message: string
    data: any
}

export interface ConsensusRequest {
    message: string
    sender: string
}
/* End of interface definitions */

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
        case "execute":
            return await manageExecution(payload.params[0] as BundleContent)
        case "hello_peer": // As it is authenticated, we can use it to check if the peer is still alive and is in our peer list
            return await manageHelloPeer(payload.params[0] as HelloPeerRequest)
        // ! Convert in progress from manageMessages.ts [[src/libs/network/routines/manageMessages.ts]]: see the calls
        case "consensus":
            return await ServerHandlers.handleConsensusRequest(payload.params[0] as ConsensusRequest)
        case "proofOfConsensus":
            return await proofConsensusHandler(payload.params[0])
        case "mempool":
            return await ServerHandlers.handleMempool(payload.params[0])
        // Auth management
        case "auth":
            return await manageAuth(payload.params[0] as AuthMessage)
        // NOTE Communications not requiring authentication
        case "nodeCall":
            return await manageNodeCall(payload.params[0] as NodeCall)

        /* SECTION Possibly deprecated methods */
        // Vote management // ? Useful or not?
        case "vote":
            return await manageVote(
                payload.params[0] as VoteRequest,
                payload.params[1] as (response: RPCResponse) => void,
            )
        case "voteRequest":
            return await ServerHandlers.handleVoteRequest(payload.params[0].timestamp)
        // ! When things are working, we should remove the login_request and login_response methods and use a "login" method with params
        case "login_request":
            return await handleLoginRequest(payload.params[0] as BrowserRequest)
        case "login_response":
            return await handleLoginResponse(
                payload.params[0] as BrowserRequest,
            )
        /* !SECTION Possibly deprecated methods */

        default:
            log.warning("[RPC Call] [Received] Method not found: " + payload.method)
            return {
                result: 404,
                response: "Method not found: " + payload.method,
                require_reply: false,
                extra: null,
            }
    }
}
/* End of processor method */

export default async function server_rpc(): Promise<Express> {
    const serverApp = express()

    // Middleware to parse JSON payloads
    serverApp.use(express.json())

    // GET request handler
    serverApp.get("/", (req: Request, res: Response) => {
        res.send("Hello, World!")
    })

    // ANCHOR Main Endpoint: POST request handler
    serverApp.post("/", async (req: Request, res: Response) => {
        if (!isRPCRequest(req.body)) {
            return res.status(400).json({ error: "Invalid RPCRequest format" })
        }
        // Extract the payload and process it
        const payload = req.body as RPCRequest
        // Header check
        const headers = req.headers
        // Excluding due to noAuthMethods from header validation
        if (!noAuthMethods.includes(payload.method)) {
            var header_validation = validateHeaders(headers)
            log.info("[RPC Call] Header validation: " + header_validation[0])
            if (!header_validation[0]) {
                return res
                    .status(401)
                    .json({ error: "Invalid headers:" + header_validation[1] })
            }
        }
        const response = await processPayload(payload)
        res.json(response)
    })

    // Start the server
    serverApp.listen(port, () => {
        console.log(`Server is running on http://localhost:${port}`)
    })

    // ? Return the server app, should we singleton it?
    return serverApp
}
