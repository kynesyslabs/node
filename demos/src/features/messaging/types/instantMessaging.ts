import Cryptography from "src/libs/crypto/cryptography"
import Hashing from "src/libs/crypto/hashing"
import * as forge from "node-forge"
import { rsa } from "src/libs/crypto" // Ensure correct path
import { pki } from "node-forge"

// INFO A Letter is a single message with data, sender and receiver and methods to work with it
export class Letter {
    from: string
    to: string
    data: Buffer

    constructor() {
        this.from = null
        this.to = null
        this.data = null
    }

    // NOTE After writing a message we have to encrypt it with the receiver's public key
    async encrypt(publicKeyRSA: pki.rsa.PublicKey): Promise<encryptedLetter> {
        let encrypted: encryptedLetter
        let stringed = JSON.stringify(this)
        encrypted.letter = await rsa.encrypt(stringed, publicKeyRSA)
        return encrypted
    }
}

// INFO An encryptedLetter is a Letter after being encrypted with the receiver's public key
export interface encryptedLetter {
    letter: string
}

// INFO A MessageContent includes a Letter, its hash and the signature of the sender for that hash
export class MessageContent {
    content: encryptedLetter
    hash: string
    signature: forge.pki.ed25519.BinaryBuffer

    constructor() {
        this.content = null
        this.hash = null
        this.signature = null
    }

    // INFO Finalizing the content by hashing and signing the encryptedLetter
    // NOTE Now the message is ready to be sent
    async finalize(privateKeyED25519: pki.ed25519.BinaryBuffer) {
        this.hash = Hashing.sha256(JSON.stringify(this.content))
        this.signature = Cryptography.sign(this.hash, privateKeyED25519)
    }
}

// NOTE Singletons mapped by id string
// INFO An InstantMessagingSession is a session between two users and contains the current message (hashed and signed) as well
//      as a list of hashes from the previous messages. currentHash ensures that the chain of hashes is not broken.
export class InstantMessagingSession {
    private static instances: Map<string, InstantMessagingSession> = new Map<
        string,
        InstantMessagingSession
    >()

    // Properties
    current: {
        messageContent: MessageContent
        previousHashes: string[]
    }
    currentHash: string

    // NOTE As per the usual integrity rules, previousHashes ensure all the messaging chain is valid
    constructor(id: string) {
        this.current = {
            messageContent: null,
            previousHashes: [],
        }
        this.currentHash = null
        // Creating the instance for this session
        InstantMessagingSession.instances.set(id, this)
    }

    // ANCHOR Statics
    public static getInstance(id: string): InstantMessagingSession {
        if (!InstantMessagingSession.instances.has(id)) {
            return null // Does not exist
        }
        return InstantMessagingSession.instances.get(id)
    }

    public static createInstance(id: string = null): InstantMessagingSession {
        if (!id) {
            id = InstantMessagingSession.makeid(32)
        }
        if (InstantMessagingSession.instances.has(id)) {
            return null // Already exists
        }
        return new InstantMessagingSession(id)
    }

    // ANCHOR Publics
    // REVIEW Cryptography stuff here if needed

    // ANCHOR Privates
    private static makeid(length: number): string {
        let result = ""
        const characters =
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
        const charactersLength = characters.length
        let counter = 0
        while (counter < length) {
            result += characters.charAt(
                Math.floor(Math.random() * charactersLength),
            )
            counter += 1
        }
        return result
    }
}
