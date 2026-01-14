import { io, Socket } from "socket.io-client"
import log from "@/utilities/logger"

export async function createConnectedSocket(
    connectionString: string,
): Promise<Socket | null> {
    return new Promise((resolve, reject) => {
        const socket = io(connectionString)

        socket.on("connect", () => {
            log.debug(`[SOCKET CONNECTOR] Connected to ${connectionString}`)
            resolve(socket)
        })

        socket.on("connect_error", err => {
            log.error(
                `[SOCKET CONNECTOR] Connection error to ${connectionString}:`,
                err,
            )
            reject(null)
        })
    })
}
