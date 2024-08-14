/*  NOTE Importing this file automatically spawns a new server that listens for RPC requests */

import express, { Request, Response, Express } from "express"
import sharedState from "src/utilities/sharedState"
import ComLinkUtils from "../communications/comlinkUtils"
import ComLink from "../communications/comlink"
import manageComLink from "./manageComlink"
import { manageAuth, AuthMessage } from "./manageAuth"
import { manageVote, VoteRequest } from "./manageVote"
import Cryptography from "../crypto/cryptography"
import Hashing from "../crypto/hashing"

// Reading the port from sharedState
const port = sharedState.getInstance().serverPort

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
/* End of interface definitions */


export default async function server_rpc(): Promise<Express> {
    const serverApp = express()

    // Middleware to parse JSON payloads
    serverApp.use(express.json())

    // GET request handler
    serverApp.get("/", (req: Request, res: Response) => {
        res.send("Hello, World!")
    })

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

    // POST request handler
    serverApp.post("/", async (req: Request, res: Response) => {
        if (!isRPCRequest(req.body)) {
            return res.status(400).json({ error: "Invalid RPCRequest format" })
        }
        // Header check
        const headers = req.headers
        var header_validation = validateHeaders(headers)
        if (!header_validation[0]) {
            return res.status(401).json({ error: "Invalid headers:" + header_validation[1] })
        }
        // Extract the payload and process it
        const payload = req.body as RPCRequest
        const response = await processPayload(payload)
        res.json(response)
    })

    // Validate the headers
    function validateHeaders(headers: any): [boolean, string] {
        // Check if we have a valid signature and identity header
        if (!headers["signature"]) {
            return [false, "Missing signature header"]
        }
        if (!headers["identity"]) {
            return [false, "Missing identity header"]
        }
        // TODO Check if the signature is valid
        const signature = headers["signature"] as string
        const identity = headers["identity"] as string
        const message = Hashing.sha256(identity)
        const isValid = Cryptography.verify(identity, signature, message)
        if (!isValid) {
            return [false, "Invalid signature"]
        }
        return [true, ""]
    }

    // Function to process the payload
    async function processPayload(payload: RPCRequest): Promise<RPCResponse> {
        // ComLink management
        switch (payload.method) {
            case "comlink":
                var comlink: ComLink = payload.params[0]
                return await manageComLink(comlink) // ! FIXME Be sure that this returns the right things

            // Auth management
            case "auth":
                return await manageAuth(payload.params[0] as AuthMessage)

            // Vote management
            case "vote":
                return await manageVote(
                    payload.params[0] as VoteRequest,
                    payload.params[1] as (response: RPCResponse) => void,
                )

            default:
                return {
                    result: 404,
                    response: "Method not found",
                    require_reply: false,
                    extra: null,
                }
        }
    }

    // Start the server
    serverApp.listen(port, () => {
        console.log(`Server is running on http://localhost:${port}`)
    })

    // ? Return the server app, should we singleton it?
    return serverApp
}
