import log from "src/utilities/logger"
import { IPeer, RPCRequest, RPCResponse } from "@kynesyslabs/demosdk/types"
import axios from "axios"
import { getSharedState } from "src/utilities/sharedState"
import Cryptography from "../crypto/cryptography"
import { NodeCall } from "../network/manageNodeCall"
import { ucrypto, uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"

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
            uint8ArrayToHex(getSharedState.keypair.publicKey as Uint8Array)
        )
    }

    // Creating an empty peer
    constructor(url = "", publicKey = "") {
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
        const p = new Peer()
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
        isAuthenticated = true,
        peers: Peer[],
        timeout = 2000,
    ): Promise<RPCResponse[]> {
        const promises = []
        let responses: RPCResponse[] = []
        for (const peer of peers) {
            promises.push(peer.call(request, isAuthenticated))
        }
        // Waiting for all responses
        const start = Date.now()
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
        log.debug(
            "[PEER] Testing connection to peer: " + this.connection.string,
        )
        const call: NodeCall = {
            message: "ping",
            data: null,
            muid: "",
        }
        const response = await this.call({
            method: "nodeCall",
            params: [call],
        })
        log.debug(
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
        isAuthenticated = true,
        sleepTime = 1000,
        retries = 3,
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
            "[PEER] [LONG CALL] [" +
                this.connection.string +
                "] Max retries reached for method: " +
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
        const ourPublicKey = (
            await ucrypto.getIdentity(getSharedState.signingAlgorithm)
        ).publicKey
        const hexPublicKey = uint8ArrayToHex(ourPublicKey as Uint8Array)
        const bufferSignature = await ucrypto.sign(
            getSharedState.signingAlgorithm,
            new TextEncoder().encode(hexPublicKey),
        )
        const hexSignature = uint8ArrayToHex(bufferSignature.signature)

        // Adding the public key at the beginning of the params
        request.params.unshift(
            getSharedState.signingAlgorithm + ":" + hexPublicKey,
        )
        // Adding the signature at the end of the params
        request.params.push(hexSignature)
        return request
    }

    // Authenticated call
    async authenticatedCall(request: RPCRequest): Promise<RPCResponse> {
        // Generating the authenticated request
        const authenticatedRequest = await this.authenticatedCallMaker(request)
        // Sending the request
        const response = await this.call(authenticatedRequest, true)
        return response
    }

    // New method to make an arbitrary RPC call
    async call(
        request: RPCRequest,
        isAuthenticated = true,
    ): Promise<RPCResponse> {
        // REVIEW: Check if OmniProtocol should be used for this peer
        if (
            getSharedState.isOmniProtocolEnabled &&
            getSharedState.omniAdapter
        ) {
            try {
                const response = await getSharedState.omniAdapter.adaptCall(
                    this,
                    request,
                    isAuthenticated,
                )
                return response
            } catch (error) {
                log.error(
                    `[Peer] OmniProtocol adaptCall failed, falling back to HTTP: ${error}`,
                )
                // Fall through to HTTP call below
            }
        }

        // HTTP fallback / default path
        return this.httpCall(request, isAuthenticated)
    }

    // REVIEW: Extracted HTTP call logic for reuse and fallback
    async httpCall(
        request: RPCRequest,
        isAuthenticated = true,
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
        const method = request.method
        const currentTimestampReadable = new Date(Date.now()).toISOString()
        // Prepare a request with our identity
        let pubkey = ""
        let signature = ""

        if (isAuthenticated) {
            const ourPublicKey = (
                await ucrypto.getIdentity(getSharedState.signingAlgorithm)
            ).publicKey
            const hexPublicKey = uint8ArrayToHex(ourPublicKey as Uint8Array)
            const bufferSignature = await ucrypto.sign(
                getSharedState.signingAlgorithm,
                new TextEncoder().encode(hexPublicKey),
            )

            pubkey = getSharedState.signingAlgorithm + ":" + hexPublicKey
            signature = uint8ArrayToHex(bufferSignature.signature)
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
            log.error("REQUEST PAYLOAD: " + JSON.stringify(request))

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
