/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import type { IPeerConfig } from "./types/Peer"
import forge from "node-forge"
import { Socket } from "socket.io-client"

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

    // INFO Check online status for a peer
    async checkOnlineStatus() {
        return {
            identity: this.identity,
            status: "online",
        }
    }
}
