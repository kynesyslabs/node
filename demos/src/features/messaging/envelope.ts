import { Partecipant } from "./partecipant"
import { Message } from "./message"

// INFO Messaging session used to represent a conversion between two parties
export interface Session {
    uid: string | null
    partecipants: Partecipant[]
    chain: {
        currentMessage: Message | null // You need to import the Message class and use it here
        designedReceiver: number | null
        previousHashes: string[]
    }
}

export class Envelope {
    session: Session
    session_signature: string | null
    constructor() {
        this.session = {
            uid: null,
            partecipants: [
                new Partecipant(null, null),
                new Partecipant(null, null),
            ],
            chain: {
                currentMessage: null, // Is a Message instance
                designedReceiver: null, // An index that represents one of the partecipants
                previousHashes: [], // List of hashes of the previous messages
            },
        }
        this.session_signature = null // Will be the signed hash of this.session
    }
}
