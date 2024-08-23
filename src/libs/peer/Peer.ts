/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import type { IPeerConfig } from "@kynesyslabs/demosdk-http/types"
import forge from "node-forge"
import log from "src/utilities/logger"
import { RPCRequest, RPCResponse } from "@kynesyslabs/demosdk-http/types"
import axios from "axios"
import sharedState from "src/utilities/sharedState"
import Cryptography from "../crypto/cryptography"
import Hashing from "../crypto/hashing"
import { HexToForge } from "../crypto/forgeUtils"
import { NodeCall } from "../network/manageNodeCall"

export default class Peer {
    // connection informations
    public connection: {
        string: string // this is optional and is mostly used for permanent connections
        // ? Communication registry?
    }
    public identity: forge.pki.ed25519.BinaryBuffer // public key
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
    constructor(address: string = "", port: number = 0, publicKey: string = "") {
        this.connection = {
            string: address + ">" + port + ">" + publicKey,
        }
        this.identity = HexToForge(publicKey)
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
        console.log("[PEER] Testing connection to peer: " + this.connection.string)
        let call: NodeCall = {
            message: "ping",
            data: null,
            muid: "",
        }
        let response = await this.call({
            method: "nodeCall",
            params: [call],
        })
        console.log("[PEER] [PING] Response: " + response.result + " - " + response.response)
        if (response.result === 200) {
            return true
        } else {
            return false
        }
    }

    // INFO Check online status for a peer
    async checkOnlineStatus(): Promise<boolean> {
        // TODO Implement RPC methods
        return true
    }

    // INFO Check if the peer is ready to be used  // TODO Implement periodically each loop in the background
    async checkReady(): Promise<boolean> {
        if (this.sync.status && this.verification.status && this.status.online) {
            this.status.ready = true
            return true
        }
        this.status.ready = false
        return false
    }

    // New method to make an arbitrary RPC call // REVIEW
    // ? As this returns a promise, should it manage its own response registry?
    async call(request: RPCRequest, isAuthenticated: boolean = true): Promise<RPCResponse> {
        // Get some informations
        let method = request.method
        let currentTimestampReadable = new Date(Date.now()).toISOString()
        // Prepare a request with our identity
        let pubkey = ""
        let signature = ""
        if (isAuthenticated) {
            pubkey = sharedState.getInstance().identity.ed25519.publicKey.toString("hex")
            signature = Cryptography.sign(pubkey, sharedState.getInstance().identity.ed25519.privateKey).toString("hex")
        }
        // Extract the url and port from the connection string
        const url = this.connection.string.split(">")[0]
        const port = this.connection.string.split(">")[1]
        const connectionUrl = url + ":" + port
        log.info("[RPC Call] [" + method + "] [" + currentTimestampReadable + "] Making RPC call to: " + connectionUrl)
        // Make the request
        try {
            const response = await axios.post<RPCResponse>(connectionUrl, request, {
                headers: {
                    "Content-Type": "application/json",
                    "identity": pubkey,
                    "signature": signature,
                },
            })
            log.info("[RPC Call] [" + method + "] [" + currentTimestampReadable + "] Response received ")
            // log.info(JSON.stringify(response.data, null, 2))
            if (response.data.result !== 200) {
                log.warning("[RPC Call] [" + method + "] [" + currentTimestampReadable + "] Response not OK: " + response.data.response + " - " + response.data.result)
            } else {
                log.info("[RPC Call] [" + method + "] [" + currentTimestampReadable + "] Response OK: " + response.data.result)
            }
            return response.data
        } catch (error) {
            log.error("Error making RPC call:" + error)
            return {         
                result: 500,
                response: error,
                require_reply: false,
                extra: null,
            }
        }
    }

}
