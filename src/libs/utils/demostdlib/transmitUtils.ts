import { pki } from "node-forge"
import ComLink from "src/libs/communications/comlink"
import Transmission from "src/libs/communications/transmission"
import sharedState from "src/utilities/sharedState"

// INFO Given a ComLink object, a response, a boolean indicating if a reply is required
// and an optional extra message, this function sends a reply to the original message
// managing identities and Transmission objects.
export async function reply(
    original_comlink: ComLink,
    response: any,
    require_reply: boolean,
    extra: string = "",
): Promise<Promise<void>> {
    let response_message = new Transmission(
        sharedState.getInstance().identity.ed25519.privateKey,
    )
    response_message.initialize(
        // TODO Specify the answer so that it has a type AND a message
        "reply",
        JSON.stringify(response),
        sharedState.getInstance().identity.ed25519.publicKey,
        "placeholder", // TODO Add the receiver, don't we already have it in the receiver object?
        null,
        extra,
    )
    await response_message.finalize()
    // Populating the comlink
    original_comlink.properties.is_reply = true // Setting the reply flag as we are replying
    original_comlink.properties.require_reply = require_reply // Setting the require_reply flag as provided above
    await original_comlink.replyToMessage(
        response_message,
        sharedState.getInstance().identity.ed25519
            .privateKey as pki.ed25519.BinaryBuffer, // REVIEW Does it work?
    )
}
