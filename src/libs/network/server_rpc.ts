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
import { handleWeb2ProxyRequest } from "./routines/transactions/handleWeb2ProxyRequest"
import { parseWeb2ProxyRequest } from "../utils/web2RequestUtils"
import manageBridges from "./manageBridge"
import { BunServer, cors, json, jsonResponse } from "./bunServer"
import { bridge } from "@kynesyslabs/demosdk"
import { manageNativeBridge } from "./manageNativeBridge"
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
function validateHeaders(headers: Headers): [boolean, string] {
    // Check if we have a valid signature and identity header
    log.info("[RPC Call] Validating headers...") // + JSON.stringify(headers, null, 2))
    if (!headers.get("signature")) {
        log.error("[RPC Call] Missing signature header")
        log.info(
            "[RPC Call] Headers: " + JSON.stringify(headers, null, 2),
            true,
        )
        //process.exit(0)
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
        case "nativeBridge":
            /**
             * TODO & REVIEW The NativeBridgeOperation is sent to the handler to obtain a response
             * that includes the compiled operation, so that the client can generate a proper transaction
             */
            return await manageNativeBridge(
                payload.params[0] as bridge.NativeBridgeOperation,
                payload.params[1] as string,
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

        case "bridge":
            return await manageBridges(sender, payload.params[0])

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

/**
 *  HTTP server using Bun
 */

export async function serverRpcBun() {
    const port = getSharedState.serverPort
    const server = new BunServer(port)

    // Apply middlewares
    server.use(cors())
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

    server.get("/publickey", () =>
        jsonResponse(getSharedState.identity.ed25519.publicKey.toString("hex")),
    )

    server.get("/connectionstring", async () =>
        jsonResponse(await getSharedState.getConnectionString()),
    )

    server.get("/peerlist", () =>
        jsonResponse(PeerManager.getInstance().getPeers()),
    )

    server.get("/public_logs", () => jsonResponse(log.getPublicLogs()))

    server.get("/diagnostics", () => jsonResponse(log.getDiagnostics()))

    // Main RPC endpoint
    server.post("/", async req => {
        try {
            const payload = await req.json()
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
                const headerValidation = validateHeaders(headers)
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
