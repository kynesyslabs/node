/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import type { IPeerConfig } from "@kynesyslabs/demosdk/types"
import forge from "node-forge"
import { Socket } from "socket.io-client"
import { Socket as ServerSocket } from "socket.io"
import log from "src/utilities/logger"
import { io } from "socket.io-client"

export default class Peer {
    // connection informations
    public connection: {
        string: string // this is optional and is mostly used for permanent connections
        socket: Socket // this is the socket object from the client pov and is mandatory
        serverSocket: ServerSocket // this is the socket object from a server pov and is mandatory
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
    constructor() {
        this.connection = {
            string: "",
            socket: null,
            serverSocket: null,
        }
        this.identity = null
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
        try {
            this.connection.socket = io(this.connection.string)
        } catch (error) {
            log.error("Peer connection to " + this.connection.string + " failed: " + error)
            return false
        }
        return true
    }

    // INFO Check online status for a peer
    async checkOnlineStatus(): Promise<boolean> {
        if (!this.connection.socket) {
            return false
        }
        // We have a socket, lets check if is connected
        return this.connection.socket.connected
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

}
