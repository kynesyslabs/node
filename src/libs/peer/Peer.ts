import log from "src/utilities/logger"
import { RPCRequest, RPCResponse } from "@kynesyslabs/demosdk/types"
import axios from "axios"
import { getSharedState } from "src/utilities/sharedState"
import Cryptography from "../crypto/cryptography"
import { NodeCall } from "../network/manageNodeCall"

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

    // Methods to handle the peer

    // INFO Connect to a peer
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
    ): Promise<RPCResponse> {
        let tries = 0
        let response = null
        while (tries < retries) {
            response = await this.call(request, isAuthenticated)
            if (response.result === 200) {
                return response
            }
            tries++
            // Sleep for sleepTime milliseconds
            await new Promise(resolve => setTimeout(resolve, sleepTime))
        }
        log.error("[PEER] [LONG CALL] Max retries reached: " + response)
        return {
            result: 400,
            response: "Max retries reached",
            require_reply: false,
            extra: response,
        }
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
        const connectionUrl = this.connection.string
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
