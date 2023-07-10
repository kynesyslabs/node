import { rsa, hashing, cryptography } from "../../libs/crypto" // Ensure correct path

/* INFO Messaging workflow
 * Each messaging session is unique and is exchanged back and forth between partecipants
 * Two Partecipant classes are instantiated to represent the two sides of the session
 * Partecipant class is also responsible for the initial and subsequent identity verification
 * Message are exchanged as Message instances containing all the necessary data
 * Message instances are finalized (RSA encrypted, hashed and signed) to ensure e2e
 * Once received, Message instance are able to self decrypt using the right RSA private key
 * Messaging.session instances contains also a chain composed of the last message plus the hash chain until now
 * To further certify integrity, Messaging.session is then hashed and signed
 */

// INFO Message instance containing all the necessary methods to manipulate a message
export class Message {
    content: string | null
    hash: string | null
    signed_hash: string | null

    constructor() {
        this.content = null // Usually utf-8 text
        this.hash = null
        this.signed_hash = null
    }

    // Decrypting a message using our own private key
    async decrypt(rsaPrivateKey: string): Promise<string> {
        let decrypted = await rsa.decrypt(this.content, rsaPrivateKey)
        return decrypted
    }

    // This function is used to hash and sign a message
    async finalize(
        privateKey: string,
        receiverRsaPublicKey: string,
    ): Promise<void> {
        // Encrypting the message
        this.content = await rsa.encrypt(this.content!, receiverRsaPublicKey)
        // Hashing the encrypted
        this.hash = hashing.sha256(this.content!)
        this.signed_hash = cryptography.sign(this.hash, privateKey)
    }

    // Easy to use verification
    async verify(publicKey: string): Promise<boolean[]> {
        let result: boolean[] = [true, true] // Hash and signature verification
        // Verifying the hash
        let supposedHash = hashing.sha256(this.content!)
        result[0] = supposedHash === this.signed_hash
        // Verifying the signature
        result[1] = cryptography.verify(this.hash, this.signed_hash, publicKey)
        return result
    }
}
