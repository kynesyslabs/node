 
import Cryptography from "src/libs/crypto/cryptography"
import Hashing from "src/libs/crypto/hashing"
import { getSharedState } from "src/utilities/sharedState"

// TODO - Implement P2P messaging off chain but attested by the node
// ? We can use the RSA keypair to encrypt the messages (shared state identity one)
// ? A partecipant will encrypt the message with the RSA keypair and then sign it with the ed25519 keypair
// ? The node will act as a relayer without knowing the content of the message, verifying the signature and then broadcasting the message to the other partecipants


// NOTE // ! Most of the methods will be local and thus will be implemented in the sdk

export interface Message {
    content: any
    signature: string
    publicKey: string
    read: boolean
}

// Multiton class to manage P2P connections and sessions
export default class DemosP2P {

    private static instances: Map<string, DemosP2P>

    // SECTION Properties and constructor

    public sessionId: string
    public partecipants: [string, string]

    public messages: Map<string, Message[]> // publicKey -> messages

    constructor(partecipants: [string, string]) {
        this.partecipants = partecipants
        this.sessionId = DemosP2P.getSessionId(partecipants[0], partecipants[1])
    }

    // SECTION Static methods

    // Multiton pattern

    public static getInstance(partecipants: [string, string]): DemosP2P {
        const sessionId = DemosP2P.getSessionId(partecipants[0], partecipants[1])
        if (!DemosP2P.instances.has(sessionId)) {
            DemosP2P.instances.set(sessionId, new DemosP2P(partecipants))
        }
        return DemosP2P.instances.get(sessionId)
    }

    public static getInstanceFromSessionId(sessionId: string): DemosP2P {
        return DemosP2P.instances.get(sessionId)
    }

    // Internal methods

    // Get the sessionId from the peerIds
    public static getSessionId(peerId1: string, peerId2: string): string {
        return Hashing.sha256(peerId1 + peerId2)
    }

    // END OF Static methods

    // SECTION Instance methods

    // Relay a message to the other partecipant
    public relayMessage(message: Message): void {
        // ! TODO Signature verification
        this.messages.get(message.publicKey).push(message)
    }

    // Get the messages for the partecipant and mark them as read
    public getMessagesForPartecipant(publicKey: string): Message[] {
        const messages = this.messages.get(publicKey)
        for (const message of messages) {
            message.read = true
        }
        return messages
    }

    // END OF Instance methods
}