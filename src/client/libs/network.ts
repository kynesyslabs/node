import * as socket_client from "socket.io-client"
import log from "@/utilities/logger"

export default class Network {
    static async rpcConnect(
        rpcUrl: string,
        socket: socket_client.Socket,
    ): Promise<socket_client.Socket> {
        try {
            socket = socket_client.connect(rpcUrl)
            let timeout = 5000
            socket.on("connect", () => {
                log.info("[Client] Connected to RPC server")
                return socket
            })
            while (timeout > 0) {
                if (socket.connected) {
                    return socket
                }
                log.debug("[Client] Waiting for socket connection...")
                await new Promise(resolve => setTimeout(resolve, 1000))
                timeout -= 1000
            }
            return null
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error)
            log.error("[Client] RPC connection failed:", errorMsg)
            return null
        }
    }
}
