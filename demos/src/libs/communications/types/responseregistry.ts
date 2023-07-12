import ComLink from "../comlink"
import Transmission from "../transmission"
import {Socket} from "socket.io"
import forge, { pki } from "node-forge"

export interface Response {
    message: string // TODO Add message type
    timestamp: number
    socket: Socket
    identity: forge.pki.ed25519.BinaryBuffer // Public key of the sender
}

export interface ResponseRegistryElement {
    comlink: ComLink
    timestamp: number
    response: Response
}
