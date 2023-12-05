import ComLink from "src/libs/communications/comlink"
import Transmission from "src/libs/communications/transmission"
import { Identity } from "src/libs/identity"
import PeerManager from "src/libs/peer/PeerManager"
import ResponseRegistry from "src/libs/communications/responseRegistry"

const peerManager = PeerManager.getInstance()
/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

const id = Identity.getInstance()

export async function sendMessageToPeers(
    messageContent: any,
): Promise<unknown> {
    let peerlist = peerManager.getPeers()
    console.log(
        `[WEB2/PEERMESSAGING] Sending message to ${peerlist.length} peers`,
    )

    for (const currentPeer of peerlist) {
        if (
            currentPeer.connectionString === "" ||
            currentPeer.connectionString === null ||
            currentPeer.connectionString === undefined
        ) {
            continue
        }
        const comLink = new ComLink()
        console.log(
            "WEB2/PEERMESSAGING: Sending message to peer " + currentPeer,
        )
        let message = new Transmission(id.ed25519.privateKey)
        message.initialize(
            "web2Request",
            messageContent,
            id.ed25519.publicKey,
            currentPeer.identity,
            null,
            null,
        )

        // Hash and sign it
        await message.finalize()

        // Preparing for a response
        comLink.properties.require_reply = true
        comLink.properties.is_reply = false

        // Propagating the responseRegistry actual status
        ResponseRegistry.getInstance().requestResponse(comLink)

        console.log("WEB2/PEERMESSAGING: Message being sent")
        // Send the message
        //console.log(JSON.stringify(message))
        await comLink.broadcastMessageToPeer(
            currentPeer,
            message,
            id.ed25519.privateKey as any,
        )

        // Wait for the response
        let response = await ResponseRegistry.getInstance().checkResponse(
            comLink.muid,
        )
        console.log("WEB2/PEERMESSAGING: Message received")
        //console.log(response)

        if (response[0]) {
            if (response[1]?.message) {
                return JSON.parse(response[1].message)
            }
        }

        // Todo: improve error handling. if response[0] is a falsy value, we should handle this better
        return null
    }
}
