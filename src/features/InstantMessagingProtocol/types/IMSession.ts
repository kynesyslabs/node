import Cryptography from 'src/libs/crypto/cryptography';
import { ForgeToHex, HexToForge } from 'src/libs/crypto/forgeUtils';

/* INFO - Structure
 *
 * An IM Session is a conversation between two partecipants.
 * Each partecipant has a public identity, which is a public key.
 * The public identity is used to encrypt messages sent to the partecipant.
 * The public identity is also used to verify the identity of the partecipant through a signature.
 * Each message is encrypted with the receiver's public key and signed with the sender's private key.
 * The messages chain is kept in the session itself and can be retrieved at any time.
 * TODO - Once per block (at consensus), the messages chain is hashed and the hash is stored in the blockchain.
 * TODO - Zk proofs will be used too
 * TODO - Aethereal messages (deleted after X from the message chain) will be implemented
*/

// INFO By declaring an identity and signing it, we can verify the identity of the partecipants in the IM Session
export interface IMHandshake {

    firstPublicIdentity: string,
    firstPublicIdentitySignature: string,
    firstPublicIdentityLock: boolean,

    secondPublicIdentity: string,
    secondPublicIdentitySignature: string,
    secondPublicIdentityLock: boolean,

}

// INFO Each message in the IM Session is an IMMessage
// NOTE Adding features to this interface allows for richer messages
export interface IMMessage {

    message: {
        data: any, // REVIEW should this be a string?
        timestamp: number, // Unix timestamp
        isEncrypted: boolean, // If true (default), the message is encrypted with the receiver's public key
    }
    signature: string, // Hex representation of the signed message as sent by the sender

}

export default class IMSession {

    // An empty handshake is created when the session is created. Once the handshake is complete, the session is ready to be used
    public handshake: IMHandshake = {
        firstPublicIdentity: "",
        firstPublicIdentitySignature: "",
        firstPublicIdentityLock: false,
        secondPublicIdentity: "",
        secondPublicIdentitySignature: "",
        secondPublicIdentityLock: false,
    };

    private messages: IMMessage[] = []; // REVIEW should this be public?



    // Any IM Session must be created with two public identities
    constructor() {
    }

    // INFO Handshake method
    public doHandshake(publicKey: string, signedPublicKey: string): [boolean, string] {
        // INFO First public identity
        if (this.handshake.firstPublicIdentity == "") {
            this.handshake.firstPublicIdentity = publicKey;
            this.handshake.firstPublicIdentitySignature = signedPublicKey;
            this.handshake.firstPublicIdentityLock = true;
            return [true, "You are the first partecipant in this IM Session"];
        }
        // INFO Second public identity
        else if (this.handshake.secondPublicIdentity == "") {
            this.handshake.secondPublicIdentity = publicKey;
            this.handshake.secondPublicIdentitySignature = signedPublicKey;
            this.handshake.secondPublicIdentityLock = true;
            return [true, "You are the second partecipant in this IM Session"];
        }
        // INFO If the handshake is complete, the session is ready to be used
        if (this.handshake.firstPublicIdentityLock && this.handshake.secondPublicIdentityLock) {
            return [false, "Handshake is already complete"];
        }
    }

    // INFO Quick retrieval of the handshake status
    public hasHandshaked(): boolean {
        if (this.handshake.firstPublicIdentityLock && this.handshake.secondPublicIdentityLock) {
            return true;
        }
        return false;
    }

    // INFO Method to check if the session is usable (reused by other methods)
    // TODO Change signature to an arbitrary message
    private isSessionValid(publicKey: string, signedKey: string): [boolean, string] {
        // Checking handshake prior to adding a message
        if (!this.hasHandshaked()) {
            return [false, "Handshake is not complete: session is not usable"];
        }
        // Only the partecipants can add messages to the session
        if (this.handshake.firstPublicIdentity != publicKey && this.handshake.secondPublicIdentity != publicKey) {
            return [false, "You are not partecipating in this IM Session"];
        }

        // We need to use the key as a forge primitive
        let bufferKey = HexToForge(publicKey);

        // Verify the signature of the key to ensure the identity of the sender
        let verified = Cryptography.verify(publicKey, signedKey, bufferKey);

        // If the signature is not verified, the message is not added
        if (!verified) {
            return [false, "The signature of the public key is not verified"];
        }
    }

    // INFO Method to add a message to the session by one of the partecipants
    public addMessage(protoMessage: IMMessage, publicKey: string, signedKey: string): [boolean, IMMessage | string] {
        // Checking if session is usable
        // (aka if the partecipant is partecipating in the session and if the signature is valid)
        let doable = this.isSessionValid(publicKey, signedKey);
        if (!doable[0]) {
            return doable;
        }

        // Adding the message to the session
        protoMessage.message.timestamp = Date.now(); // And now the message is valid and complete
        this.messages.push(protoMessage);

        // Returning the message
        return [true, protoMessage];
    }

    // TODO Add flexibility to the retrieval of messages
    public retrieveMessages(publicKey: string, signedKey: string, since?: number, to?: number): [boolean, IMMessage[] | string] {
        // Checking if session is usable
        // (aka if the partecipant is partecipating in the session and if the signature is valid)
        let doable = this.isSessionValid(publicKey, signedKey);
        if (!doable[0]) {
            return doable;
        }

        let totalMessages = this.messages.length;
        // TODO
        if (!since) {
            since = 0;
        }
        if (!to) {
            to = totalMessages;
        }
        let retrievedMessages = this.messages.slice(since, to);
        return [true, retrievedMessages];
    }



}