/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

// TODO Do the same but with connectionString

import { Socket } from "socket.io"

import log from "src/utilities/logger"
import Transmission from "../../communications/transmission"
import Peer from "../Peer"
import { NodeCall } from "src/libs/network/manageNodeCall"

export default async function getPeerConnectionString(
    peer: Peer,
    id: any,
): Promise<Peer> {
    const nodeCall: NodeCall = {
        message: "getPeerConnectionString",
        data: null,
        muid: null,
    }
    const response = await peer.call({
        method: "nodeCall",
        params: [nodeCall],
    })
    // Response management
    if (response.result === 200) {
        log.debug("[PEER CONNECTION] Received response")
        peer.connection.string = response.response
    } else {
        log.warning(
            "[PEER CONNECTION] Response " +
                response.result +
                " received: " +
                response.response,
        )
    }
    return peer
}
