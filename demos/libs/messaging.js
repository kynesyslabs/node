// INFO This module contain classes and methods used to manage on chain instant messaging

// import dependencies
let Messaging = require("./classes/messaging_class.js")
let identity = require("./identity.js")

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
    // TODO Handling first contact, subsequent contacts and closing contacts
    },
}

module.exports = messaging