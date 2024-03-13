// INFO As in ActivityPub (hence the compatibility), the IMStorage is a
// mapping between a user and a list of IMs. The difference is that the
// IMs are not ActivityPub objects but IM objects.
// The logic remains the same: each user has a inbox and an outbox.
// By posting to the inbox, the user sends a message to the other user.
// By posting to the outbox, the user publishes the reply so that the other user can read it.
import Cryptography from "src/libs/crypto/cryptography"
import { HexToForge } from "src/libs/crypto/forgeUtils"
import { demostdlib } from "src/libs/utils"

import { outbox } from "../../activitypub/feditypes"
// Using RSA and ED25519, privacy and authenticity are guaranteed even in a public decentralized context.
import { IMMessage } from "./IMSession"

export interface IMStorage {
    inbox: IMMessage[]
    outbox: IMMessage[]
}

export default class IMStorageInstance {
    // REVIEW Check the stability of the Storage type
    // REVIEW Also we should make this persistent (or not? Aethereal messages are not persistent)
    private static storages: Map<string, IMStorage> = new Map<
        string,
        IMStorage
    >()

    constructor() {}

    // INFO Method to check if the actor can act on  a property
    // TODO Change signature to an arbitrary message
    private static isAuthorized(
        publicKey: string,
        signedKey: string,
        allowedKeys: string[],
    ): [boolean, string] {
        // First of all, we need to check if the public key is allowed to act
        if (!allowedKeys.includes(publicKey)) {
            return [
                false,
                "You are not allowed to act on this property (Not allowed)",
            ]
        }

        // We need to use the key as a forge primitive
        let bufferKey = HexToForge(publicKey)

        // Verify the signature of the key to ensure the identity of the actor
        let verified = Cryptography.verify(publicKey, signedKey, bufferKey)

        // If the signature is not verified, the request is not authorized
        if (!verified) {
            return [
                false,
                "You are not allowed to act on this property (Unverified)",
            ]
        }

        // If the signature is verified, the request is authorized
        return [true, "You are allowed to act on this property"]
    }

    // INFO Outboxes are public to read, but private to write
    public static getOutboxes(
        publicKey: string,
    ): [boolean, IMMessage[] | string] {
        if (!this.storages.has(publicKey)) {
            this.storages.set(publicKey, { inbox: [], outbox: [] })
        }
        let outbox = this.storages.get(publicKey).outbox
        return [true, outbox]
    }
    public static writeToOutbox(
        publicKey: string,
        signedKey: string,
        message: IMMessage,
    ) {
        // Checking Authorization
        if (!this.isAuthorized(publicKey, signedKey, [publicKey])[0]) {
            return [false, "You are not allowed to act on this property"]
        }
        let account = this.storages.get(publicKey)
        account.outbox.push(message)
        this.storages.set(publicKey, account)
        return [true, "Message written to the outbox"]
    }

    // INFO Inboxes are public to write, but private to read
    public static getInboxes(
        publicKey: string,
        signedKey: string,
    ): [boolean, IMMessage[] | string] {
        // Checking Authorization
        if (!this.isAuthorized(publicKey, signedKey, [publicKey])[0]) {
            return [false, "You are not allowed to act on this property"]
        }
        let inbox = this.storages.get(publicKey).inbox
        return [true, inbox]
    }
    public static writeToInbox(
        publicKey: string,
        message: IMMessage,
    ): [boolean, string] {
        if (!this.storages.has(publicKey)) {
            this.storages.set(publicKey, { inbox: [], outbox: [] })
        }
        let account = this.storages.get(publicKey)
        account.inbox.push(message)
        this.storages.set(publicKey, account)
        return [true, "Message written to the inbox"]
    }
}
