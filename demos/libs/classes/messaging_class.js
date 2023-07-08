// INFO Main classes that provides messaging.js with functionalities
const identity = require("../identity")

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

// INFO Identity class for the partecipants
class Partecipant {
    constructor(address, route) {
        this.address = address // Public key of the partecipant
        this.route = route // last known URL of the partecipant
        this.login_signature = {
            login_message: null,
            signature: null,
        } // By verifying this, we can infer logged in or out status
    }
    // INFO Testing if the route is still valid
    check_route() {
        // TODO Connect to test
    }
    // INFO Generating a login challenge that the client must sign
    login_challenge() {
        let timestamp = Date.now()
        this.login_signature.login_message = "Logging " + this.address + " @ " + timestamp
    }
    // INFO Verifying a login message against the challenge
    login_verify(signature) {
        return identity.cryptography.verify(this.login_signature.login_message, signature)
    }
}

// INFO Message instance containing all the necessary methods to manipulate a message
class Message {
    constructor() {
        this.content = null // Usually utf-8 text
        this.hash = null
        this.signed_hash = null
    }
    // INFO Decrypting a message using our own private key
    decrypt(rsa_private_key) {
        let decrypted = identity.RSA.decrypt(this.content, rsa_private_key)
        return decrypted
    }
    // INFO This function is used to hash and sign a message
    finalize(privateKey, receiver_rsa_public_key) {
        // Encrypting the message
        this.content = identity.RSA.encrypt(this.content, receiver_rsa_public_key)
        // Hashing the encrypted
        this.hash = identity.hashing.sha256(this.content)
        this.signed_hash = identity.cryptography.sign(this.hash, privateKey)
    }
    // INFO Easy to use verification
    verify(publicKey) {
        let result = [true, true] // Hash and signature verification
        // Verifying the hash
        let _supposedHash = identity.hashing.sha256(this.content)
        result[0] = (_supposedHash === this.signed_hash)
        // Verifying the signature
        result[1] = identity.cryptography.verify(this.signed_hash, publicKey)
        return result
    }
}

// INFO Messaging session used to represent a conversion between two parties
class Envelope {
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

module.exports = { Envelope, Partecipant, Message}
