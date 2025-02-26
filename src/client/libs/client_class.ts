import forge from "node-forge"
import * as socket from "socket.io"
import * as socket_client from "socket.io-client"

import Network from "./network"

export default class Client {
    private static instance: Client

    STATUS_PROMPT: string
    STATUS_FLAG: string

    rpc_url: string
    socket: socket_client.Socket
    identity: forge.pki.ed25519.BinaryBuffer // PrivateKey will be stored here most probably

    constructor() {
        this.rpc_url = ""
        this.identity = null
        this.STATUS_PROMPT = "Disconnected"
        this.STATUS_FLAG = "OK"
        this.socket = null
    }

    // SECTION CLI Operations
    async connect(url: string): Promise<void> {
        this.rpc_url = url
        const success = await Network.rpcConnect(this.rpc_url, this.socket)
        if (success) {
            console.log("Connected to server")
            this.STATUS_PROMPT = "Connected"
            this.STATUS_FLAG = "OK"
            this.socket = success
        } else {
            this.STATUS_PROMPT = "Disconnected"
            this.STATUS_FLAG = "ERROR"
        }
    }

    async disconnect(): Promise<void> {
        this.rpc_url = ""
        this.identity = null
        // TODO Stuff
        this.STATUS_PROMPT = "Disconnected"
        this.STATUS_FLAG = "OK"
    }

    // !SECTION CLI Operations
}
