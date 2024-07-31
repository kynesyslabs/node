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
    // status informations
    public status: {
        online: boolean // is the peer online
        timestamp: number // timestamp of the last online status check
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
        this.status = {
            online: false,
            timestamp: null,
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

}
