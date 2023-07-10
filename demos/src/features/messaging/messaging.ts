import { cryptography } from "src/libs/crypto"
import { Envelope } from "src/features/messaging"
import { Identity } from "src/libs/identity"

export class Messaging {
    static async parseRequest(request) {
        // Applying object
        let envelope = new Envelope()
        envelope = request.message
        // As far as it should be, at this point the message is already validated by the comlink
        let _hexSender = Buffer.from(request.sender).toString("hex")
        // ANCHOR Internal methods
        let estabilishContact = async function () {
            // Used for first contacts
            // Filling the partecipants[1] field with ourselves if we are the receivers
            const id = Identity.getInstance()
            let _ourselves = Buffer.from(id.ed25519.publicKey as any).toString(
                "hex",
            )
            if (_hexSender === _ourselves) {
                envelope.session.partecipants[1].route = "placeholder" // TODO Public address + port
                envelope.session.partecipants[1].login_signature.login_message =
                    "I am " +
                    Buffer.from(id.ed25519.publicKey as any).toString("hex")
                let signed_id = cryptography.sign(
                    envelope.session.partecipants[1].login_signature
                        .login_message,
                    id.ed25519.privateKey as any,
                )
                envelope.session.partecipants[1].login_signature.signature =
                    signed_id
                console.log(
                    "[MESSAGE ANALYSIS] Message is for us! Added our identity to the path",
                )
                // TODO Do stuff
            } else {
                console.log(
                    "[MESSAGE ANALYSIS] We are not the receivers, routing",
                )
                // TODO Add routing methods to send the message to the receiver
            }
        }
        // TODO Detect closing contacts
        //let stringedMessage = JSON.stringify(envelope, null, 2)
        console.log("[MESSAGE RECEIVED by " + _hexSender + "]")
        // REVIEW Should we validate the message here?
        let partecipants = envelope.session.partecipants
        // Checking if we have one participant (first contact)
        if (!partecipants[1].login_signature.signature) {
            console.log("[MESSAGE ANALYSIS] This is a first contact")
            // TODO Manage first contact
            await estabilishContact()
        } else {
            console.log("[MESSAGE ANALYSIS] Looks like a reply")
            // TODO Manage subsequent contacts
        }
    }
}
