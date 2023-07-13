import {Socket} from "socket.io-client"

export interface IPeerConfig {
    connectionString?: string
    socket?: Socket
    identity?: string
}
