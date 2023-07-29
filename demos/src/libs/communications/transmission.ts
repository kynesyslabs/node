/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

// INFO This module exposes methods designed to have an unified way of communicate in DEMOS
import Hashing from "../crypto/hashing"
import Cryptography from "../crypto/cryptography"
import forge, { pki } from "node-forge"
import { Bundle } from "./types/transmit"
import { Peer } from "../peer"

export default class Transmission {
    bundle: Bundle
    receiver_peer: Peer // TODO Do peer interface
    privateKey: pki.ed25519.BinaryBuffer

    constructor(privateKey=null) {
        this.bundle = {
            content: {
                type: null,
                message: null,
                sender: null,
                receiver: null,
                timestamp: null,
                data: null,
                extra: null,
            },
            hash: null,
            signature: null,
        }
        this.receiver_peer = null
        this.privateKey = privateKey
    }

    // INFO Initialize a message object with the given parameters
    initialize(type, message, sender_public, receiver, data, extra) {
        this.bundle.content.type = type
        this.bundle.content.message = message
        this.bundle.content.sender = sender_public
        this.bundle.content.receiver = receiver.identity
        this.bundle.content.data = data
        this.bundle.content.extra = extra
        this.bundle.content.timestamp = Date.now()
        this.receiver_peer = receiver
    }

    // INFO Hash and sign a message
    async finalize() {
        // Hash the content
        this.bundle.hash = Hashing.sha256(JSON.stringify(this.bundle.content)) // REVIEW is this ok?
        // Sign the hash if needed
        if (this.privateKey!= null) { // NOTE: For things like nodeCall we dont need it necessarily
            this.bundle.signature = await Cryptography.sign(
                this.bundle.hash,
                this.privateKey,
            ) // REVIEW We shouldn't have to stringify the hash
        }
    }
}
