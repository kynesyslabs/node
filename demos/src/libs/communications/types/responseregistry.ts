import ComLink from "../comlink"
import Transmission from "../transmission"
import {Socket} from "socket.io"

export interface Response {
    message: string // TODO Add message type
    timestamp: number
    socket: Socket
}

export interface ResponseRegistryElement {
    comlink: ComLink
    timestamp: number
    response: Response
}
