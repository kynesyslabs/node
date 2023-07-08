// INFO This module contain classes and methods used to manage on chain instant messaging

// import dependencies
let Messaging = require("./classes/messaging_class.js")

/* NOTE request.content structure for messaging transmission (as is a Message type of object)
 	content: {
                type: "messaging",
                message: {
					stage: "handshake" | "chat" | "closing",
					data: Messaging.Envelope object (see messaging_class.js)
				},
                sender: address,
                receiver: address,
                timestamp: timestamp,
                data: null
                extra: null,
            }
*/

let messaging = {
    parseRequest: async function (request) {
    // TODO Detect closing contacts
        // Applying object
        let envelope = new Messaging.Envelope()
        envelope = request.message
        // As far as it should be, at this point the message is already validated by the comlink
        let _hexSender = Buffer.from(request.sender).toString("hex")
        let stringedMessage = JSON.stringify(envelope, null, 2)
        console.log("[MESSAGE RECEIVED by " + _hexSender + "]")
        // REVIEW Should we validate the message here?
        let partecipants = envelope.session.partecipants
        // Checking if we have one participant (first contact)
        if (!partecipants[1].address) {
            console.log("[MESSAGE ANALYSIS] This is a first contact")
            // TODO Manage first contact
        } else {
            console.log("[MESSAGE ANALYSIS] Looks like a reply")
            // TODO Manage subsequent contacts
        }
    },
}

module.exports = messaging