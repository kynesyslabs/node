import forge from "node-forge"
import * as socket_client from "socket.io-client"
import log from "@/utilities/logger"

import Network from "./network"

export default class Client {
    private static instance: Client

    STATUS_PROMPT: string
    STATUS_FLAG: string

    rpc_url: string
    socket: socket_client.Socket
    identity: forge.pki.ed25519.BinaryBuffer

    constructor() {
        this.rpc_url = ""
        this.identity = null
        this.STATUS_PROMPT = "Disconnected"
        this.STATUS_FLAG = "OK"
        this.socket = null
    }

    async connect(url: string): Promise<void> {
        this.rpc_url = url
        const success = await Network.rpcConnect(this.rpc_url, this.socket)
        if (success) {
            log.info("[Client] Connected to server")
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
        this.STATUS_PROMPT = "Disconnected"
        this.STATUS_FLAG = "OK"
    }
}
