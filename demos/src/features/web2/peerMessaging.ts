import ComLink from "src/libs/communications/comlink"
import Transmission from "src/libs/communications/transmission"
import { Identity } from "src/libs/identity"
import PeerManager from "src/libs/peer/PeerManager"
import { responseRegistry } from "src/libs/communications"

const peerManager = PeerManager.getInstance()
const id = Identity.getInstance()

export async function sendMessageToPeers(messageContent: any) {
    let peerlist = peerManager.getPeers()
    console.log(
        `[WEB2/PEERMESSAGING] Sending message to ${peerlist.length} peers`,
    )

    for (const currentPeer of peerlist) {
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
        responseRegistry.getInstance().requestResponse(comLink)

        console.log("WEB2/PEERMESSAGING: Message being sent")
        // Send the message
        await comLink.broadcastMessageToPeer(
            currentPeer,
            message,
            id.ed25519.privateKey as any,
        )

        // Wait for the response
        let response = await responseRegistry
            .getInstance()
            .checkResponse(comLink.muid)
        console.log("WEB2/PEERMESSAGING: Message received")
        console.log(response)

        return response
    }
}
