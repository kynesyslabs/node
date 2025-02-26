import * as socket_client from "socket.io-client"

export default class Network {
    static async rpcConnect(
        rpcUrl: string,
        socket: socket_client.Socket,
    ): Promise<socket_client.Socket> {
        try {
            socket = socket_client.connect(rpcUrl)
            let timeout = 5000
            socket.on("connect", () => {
                console.log("Connected to RPC server")
                return socket
            })
            while (timeout > 0) {
                if (socket.connected) {
                    return socket
                }
                console.log("Waiting for socket connection...")
                await new Promise(resolve => setTimeout(resolve, 1000))
                timeout -= 1000
            }
            return null
        } catch (e) {
            console.log(e)
            return null
        }
    }
}
