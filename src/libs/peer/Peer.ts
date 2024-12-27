import log from "src/utilities/logger"
import { IPeer, RPCRequest, RPCResponse } from "@kynesyslabs/demosdk/types"
import axios from "axios"
import { getSharedState } from "src/utilities/sharedState"
import Cryptography from "../crypto/cryptography"
import { NodeCall } from "../network/manageNodeCall"

export interface SyncData {
    status: boolean
    block: number
    block_hash: string
}

export default class Peer {
    // connection informations
    public connection: {
        string: string // this is optional and is mostly used for permanent connections
    }
    public identity: string // public key
    // verification informations
    public verification: {
        status: boolean // has been verified against the public key
        message: string // message from the peer at the time of verification
        timestamp: number // timestamp of the verification
    }
    // sync informations // TODO Implement
    public sync: {
        status: boolean // is the peer synced to our last block
        block: number // the last block number we know the peer is synced to
        block_hash: string // the hash of the last block we know the peer is synced to
    }
    // status informations
    public status: {
        online: boolean // is the peer online
        timestamp: number // timestamp of the last online status check
        ready: boolean // is the peer ready to be used (aka 1. synced, 2. verified, 3. online, 4. not in an error state)  // TODO Implement
    }

    get isLocalNode(): boolean {
        return (
            this.identity ===
            getSharedState.identity.ed25519.publicKey.toString("hex")
        )
    }

    // Creating an empty peer
    constructor(url: string = "", publicKey: string = "") {
        this.connection = {
            string: url,
        }
        this.identity = publicKey
        this.verification = {
            status: false,
            message: null,
            timestamp: null,
        }
        this.sync = {
            status: false,
            block: null,
            block_hash: null,
        }
        this.status = {
            online: false,
            timestamp: null,
            ready: false,
        }
    }

    // Importing a peer from an IPeer
    static fromIPeer(peer: IPeer): Peer {
        let p = new Peer()
        p.connection = peer.connection
        p.identity = peer.identity
        p.verification = peer.verification
        p.sync = peer.sync
        p.status = peer.status
        return p
    }

    // REVIEW Method to make the same call with multiple peers
    static async multiCall(
        request: RPCRequest,
        isAuthenticated: boolean = true,
        peers: Peer[],
        timeout: number = 2000,
    ): Promise<RPCResponse[]> {
        let promises = []
        let responses: RPCResponse[] = []
        for (let peer of peers) {
            promises.push(peer.call(request, isAuthenticated))
        }
        // Waiting for all responses
        let start = Date.now()
        while (Date.now() - start < timeout) {
            responses = await Promise.all(promises)
        }
        if (responses.length !== promises.length) {
            log.warning(
                "[PEER] [MULTI CALL] Timeout reached, some responses were missed",
            )
        }
        return responses
    }

    // Methods to handle the peer

    /**
     * Connect to a peer
     * @returns True if the peer is online, false otherwise
     */
    async connect(): Promise<boolean> {
        console.log(
            "[PEER] Testing connection to peer: " + this.connection.string,
        )
        let call: NodeCall = {
            message: "ping",
            data: null,
            muid: "",
        }
        let response = await this.call({
            method: "nodeCall",
            params: [call],
        })
        console.log(
            "[PEER] [PING] Response: " +
                response.result +
                " - " +
                response.response,
        )
        if (response.result === 200) {
            return true
        } else {
            return false
        }
    }

    // TODO (WIP) call with retries on fail
    async longCall(
        request: RPCRequest,
        isAuthenticated: boolean = true,
        sleepTime: number = 1000,
        retries: number = 3,
        allowedErrors: number[] = [],
    ): Promise<RPCResponse> {
        let tries = 0
        let response = null
        while (tries < retries) {
            response = await this.call(request, isAuthenticated)
            if (
                response.result === 200 ||
                allowedErrors.includes(response.result)
            ) {
                return response
            }
            tries++
            // Sleep for sleepTime milliseconds
            await new Promise(resolve => setTimeout(resolve, sleepTime))
        }
        const methodString =
            request.params.length > 0
                ? `${request.method}.${request.params[0].method}`
                : request.method
        log.error(
            "[PEER] [LONG CALL] Max retries reached for method: " +
                methodString +
                " - " +
                response,
        )
        return {
            result: 400,
            response: "Max retries reached",
            require_reply: false,
            extra: response,
        }
    }

    // Returning the authenticated call without sending the request
    /** NOTE This method is used to add the public key and the signature to the request
     * This is to ensure that the secretary can identify the sender of the request and validate its signature
     * Example: a request with params like [...params] will become [public_key, ...params, signature]
     */
    async authenticatedCallMaker(request: RPCRequest): Promise<RPCRequest> {
        // Signing our identity to send the request
        const bufferSignature = await Cryptography.sign(
            getSharedState.identity.ed25519.publicKey.toString("hex"),
            getSharedState.identity.ed25519.privateKey,
        )
        // Adding the public key at the beginning of the params
        request.params.unshift(
            getSharedState.identity.ed25519.publicKey.toString("hex"),
        )
        // Adding the signature at the end of the params
        request.params.push(bufferSignature.toString("hex"))
        return request
    }

    // Authenticated call
    async authenticatedCall(request: RPCRequest): Promise<RPCResponse> {
        // Generating the authenticated request
        let authenticatedRequest = await this.authenticatedCallMaker(request)
        // Sending the request
        let response = await this.call(authenticatedRequest, true)
        return response
    }

    // New method to make an arbitrary RPC call
    async call(
        request: RPCRequest,
        isAuthenticated: boolean = true,
    ): Promise<RPCResponse> {
        log.info(
            "[RPC Call] [" +
                request.method +
                "] [" +
                new Date(Date.now()).toISOString() +
                "] Making RPC call to: " +
                this.connection.string,
        )
        // Get some informations
        let method = request.method
        let currentTimestampReadable = new Date(Date.now()).toISOString()
        // Prepare a request with our identity
        let pubkey = ""
        let signature = ""
        if (isAuthenticated) {
            pubkey = getSharedState.identity.ed25519.publicKey.toString("hex")
            signature = Cryptography.sign(
                pubkey,
                getSharedState.identity.ed25519.privateKey,
            ).toString("hex")
        }
        // REVIEW Using the connection string as the url with the new format
        let connectionUrl = this.connection.string

        // INFO: If the peer is the local node, we use the internal connection string
        if (this.isLocalNode) {
            connectionUrl = getSharedState.connectionString
        }

        log.info(
            "[RPC Call] [" +
                method +
                "] [" +
                currentTimestampReadable +
                "] Making RPC call to: " +
                connectionUrl,
        )
        // Make the request
        try {
            const response = await axios.post<RPCResponse>(
                connectionUrl,
                request,
                {
                    headers: {
                        "Content-Type": "application/json",
                        identity: pubkey,
                        signature: signature,
                    },
                    timeout: 3000,
                },
            )
            log.info(
                "[RPC Call] [" +
                    method +
                    "] [" +
                    currentTimestampReadable +
                    "] Response received ",
            )
            // log.info(JSON.stringify(response.data, null, 2))
            if (response.data.result !== 200) {
                log.warning(
                    "[RPC Call] [" +
                        method +
                        "] [" +
                        currentTimestampReadable +
                        "] Response not OK: " +
                        response.data.response +
                        " - " +
                        response.data.result,
                )
            } else {
                log.info(
                    "[RPC Call] [" +
                        method +
                        "] [" +
                        currentTimestampReadable +
                        "] Response OK: " +
                        response.data.result,
                )
            }
            return response.data
        } catch (error) {
            log.error(
                "[RPC Call] [" +
                    method +
                    "] [" +
                    currentTimestampReadable +
                    "] Error making RPC call:" +
                    error,
            )
            log.error("CONNECTION URL: " + connectionUrl)
            log.error("REQUEST PAYLOAD: " + JSON.stringify(request, null, 2))

            return {
                result: 500,
                response: error,
                require_reply: false,
                extra: null,
            }
        }
    }

    // INFO Fetch through http get
    async fetch(endpoint: string): Promise<any> {
        // Sanitize the url
        if (endpoint.startsWith("/")) {
            endpoint = endpoint.substring(1)
        }
        if (this.connection.string.endsWith("/")) {
            this.connection.string = this.connection.string.slice(0, -1)
        }
        const url = this.connection.string + "/" + endpoint
        log.info("[Fetch] Making fetch call to: " + url)
        const response = await axios.get(url)
        return response.data
    }

    async getInfo(): Promise<any> {
        return await this.fetch("info")
    }
}
