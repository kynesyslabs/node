/*
    This class defines the L2PS object, which is used as a blueprint for every
    L2PS that we will interact with.
    L2PS networks are defined in the GLS and can be recreated as objects from their
    public key.
    Partecipants are the entities that are part of the L2PS network and must be able to
    demonstrate their identity against the Partecipants list.
    Moreover, they must be able to autonomously encrypt and decrypt messages on the L2PS they
    are part of.
*/
import Hashing from "src/libs/crypto/hashing"
import Cryptography from "src/libs/crypto/cryptography"
import * as forge from "node-forge"
import required from "src/utilities/required"
import { decrypt } from "dotenv"
import { Transaction } from "@kynesyslabs/demosdk/types"

/* TODOs and ideas
    ? Should we have a mechanism for key rotation?
*/

export default class L2PS {

    // Compiled at construction time based on the input
    rsaKeyPair: forge.pki.rsa.KeyPair = null
    uid: string = null
    partecipant: boolean = false

    // If no keypair is provided, a new one is generated. A keypair may be provided
    // to import an existing L2PS with full control over the keypair (e.g. Partecipants).
    // One can also import an L2PS as an external entity, in which case the keypair is not
    // needed and the import is only based on the UID. In this case, the import cannot
    // act within the L2PS.
    constructor(create: boolean, _rsaKeyPair?: forge.pki.rsa.KeyPair, _uid?: string) {
        // Importing as partecipant or as external
        if (!create) {
            if (_rsaKeyPair) { // Importing as partecipant
                this.rsaKeyPair = _rsaKeyPair
                this.uid = Hashing.sha256(_rsaKeyPair.publicKey.n.toString(16))
                this.partecipant = true
            } else { // Importing as external
                required(_uid, "uid")
                this.uid = _uid
            }
            // We need an existing L2PS to fetch the partecipants list, as it is not created from scratch
            let existing = this.fetchL2PSFromGLS(Hashing.sha256(_rsaKeyPair.publicKey.n.toString(16)))
            // If the L2PS does not exist, we throw an error
            if (!existing) {
                throw new Error("L2PS not found")
            }
        }
        // Creating a new L2PS, we disregard the rest of the parameters
        else {
            this.rsaKeyPair = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 })
            this.uid = Hashing.sha256(this.rsaKeyPair.publicKey.n.toString(16))
            this.partecipant = true
        }
    }

    // Encrypt the message for the L2PS
    // NOTE This can be used by anyone, not only partecipants, as it requires the public key
    public encryptForL2PS(message: string): string {
        let encrypted = this.rsaKeyPair.publicKey.encrypt(forge.util.encode64(message))
        return encrypted
    }

    // Decrypt the message from the L2PS
    // NOTE This can be used only by partecipants as it requires the private key
    public decryptFromL2PS(message: string): string {
        required(this.partecipant, "partecipant pre-flight check failed")
        required(this.rsaKeyPair.privateKey, "privateKey is missing")
        let decrypted = this.rsaKeyPair.privateKey.decrypt(message)
        return decrypted
    }

    // SECTION Class methods

    // * Management methods

    // Fetch the L2PS info from the GLS
    public async fetchL2PSFromGLS(uid: string): Promise<void> {
        // TODO Call the GLS to see if we have a L2PS with this UID
        // TODO If we have it, fetch the partecipants list and fill the object
        // TODO We also fill the uid, while the keypair can be left untouched (non partecipant import)
    }

    // * Tx methods

    // Fetch and decrypt a Tx from the L2PS registry in the GLS
    public async fetchTxFromGLS(txId: string): Promise<Transaction> {
        required(this.partecipant, "partecipant pre-flight check failed")
        required(this.rsaKeyPair.privateKey, "privateKey is missing")
        // TODO Call the GLS to fetch a Tx from the L2PS registry in the GLS
        // TODO The Tx must be decrypted with the private key of the L2PS
        // TODO The Tx must contain the UID of the L2PS (create a proper type for this)
        // TODO Return the decrypted Tx
        return null
    }

    // Insert an encrypted Tx into the L2PS registry in the GLS
    public async registerTxToGLS(tx: Transaction): Promise<void> {
        let encryptedTx = this.encryptForL2PS(JSON.stringify(tx))
        // TODO Call the GLS to register a Tx into the L2PS registry in the GLS
        // TODO The Tx must be encrypted with the public key of the L2PS
        // TODO The Tx must contain the UID of the L2PS (create a proper type for this)
    }


    // SECTION Static methods

    // A valid partecipant will send a signed timestamp as a string that must be within the last 5 minutes
    public static checkPartecipantIdentity(partecipant: forge.pki.ed25519.BinaryBuffer, timestamp: number | string, signature: forge.pki.ed25519.BinaryBuffer): [boolean, string] {
        // Sanitizing input
        if (typeof timestamp === "string") {
            timestamp = parseInt(timestamp)
        }
        // Checking time validity
        const now = new Date().getTime()
        if (now - timestamp > 300000) {
            return [false, "Timestamp is too old"]
        }
        // Checking signature validity by converting the timestamp to a string
        const hash = Hashing.sha256(timestamp.toString())
        const valid = Cryptography.verify(hash, signature, partecipant)
        return [valid, valid ? "Valid signature" : "Invalid signature"]
    }
}