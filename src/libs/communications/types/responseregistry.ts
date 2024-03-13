import forge from "node-forge"
import { Socket } from "socket.io"
import * as socket_client from "socket.io-client"
/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/
import Datasource from "src/model/datasource"

import ComLink from "../comlink"
import Transmission from "../transmission"

export interface Response {
    message: string // TODO Add message type
    timestamp: number
    socket: Socket | socket_client.Socket
    identity: forge.pki.ed25519.BinaryBuffer // Public key of the sender
    connection_string: string
}

export interface ResponseRegistryElement {
    comlink: ComLink
    timestamp: number
    response: Response
}
