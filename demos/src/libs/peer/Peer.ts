import type { IPeerConfig } from "./types/Peer"
import { Socket } from "socket.io-client"
import * as forge from "node-forge"

export default class Peer {
    connectionString: string
    socket: Socket
    identity: forge.pki.ed25519.BinaryBuffer // public key

    constructor(config?: IPeerConfig) {
        this.connectionString = config?.connectionString
        this.socket = config?.socket
        this.identity = config?.identity
    }

    // Methods
    // INFO Set the connection string of the peer
    setConnectionString(connectionString) {
        this.connectionString = connectionString
    }
    // INFO Set the socket of the peer
    setSocket(socket) {
        this.socket = socket
    }
    // INFO Set the identity of the peer
    setIdentity(identity) {
        this.identity = identity
    }

    // INFO Getting the socket
    getSocket() {
        return this.socket
    }

}
