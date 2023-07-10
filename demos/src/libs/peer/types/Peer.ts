import {Socket} from "socket.io"

export interface IPeerConfig {
    connectionString?: string
    socket?: Socket
    identity?: string
}
