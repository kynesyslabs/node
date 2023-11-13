/* INFO Enigma - An experimental wrapper for Post Quantum Cryptography in Typescript designed with ease of use in mind

    This module incorporates two Post Quantum Cryptography methods:
    - McEliece: post-quantum cryptography algorithm that uses a keypair to share secrets between two parties.
    - Dilithium: post-quantum cryptography algorithm that uses a keypair to sign and verify messages.

    The McEliece algorithm is used to encrypt and decrypt messages, much like a symmetric classic encryption algorithm.
    Thanks to its post-quantum security, however, it is not possible to retrieve the secrets as easily as with a classic algorithm.
    We use McEliece to exchange a long-term secret between two parties. This secret will be the base to generate one-time secrets
    encrypted with McEliece itself that will be used to generate one-time symmetric keys.

    The Dilithium algorithm is used to sign and verify messages, much like algorithms like ed25519.
    Apart from providing post quantum security, the Dilithium algorithm is also capable of generating combined signed messages
    that can be used to verify signatures without sharing the initial message, as proofs of authenticity.

    Credits:
    - https://github.com/cyph for its https://github.com/cyph/pqcrypto.js library (superdilithium, supersphincs and a lot of knowledge)
    - https://github.com/tniessen for its https://github.com/tniessen/node-mceliece-nist library (mceliece and a lot of knowledge too)
    - I can't find the ntru library developer unfortunately, feel free to contact me if its you

*/

import { superDilithium } from "superdilithium"
// import { superSphincs } from "supersphincs" // Same as above, just replace the two strings
import { McEliece } from "mceliece-nist"
// import {ntru} from "ntru" // Interchangeable with McEliece

// INFO Interface to happily work with almost any keypair
export interface IKeypair {
    privateKey: Uint8Array
    publicKey: Uint8Array
}

// INFO Main class
export default class Enigma {
    signingKeyPair: IKeypair = null
	mcelieceKeypair: IKeypair = null

	private kem: McEliece = new McEliece("mceliece8192128")


    constructor() {}

    async init() {
        this.signingKeyPair = await superDilithium.keyPair()
		this.mcelieceKeypair = this.kem.keypair()
    }

    /* SECTION Signatures with superDilithium */

    async combinedSign(
        message: string,
        additionalData: string = null,
    ): Promise<Uint8Array> {
        let bufMessage = Buffer.from(message, "utf8")
        let signed: Uint8Array
        if (additionalData) {
            let bufAdditionalData = Buffer.from(additionalData, "utf8")
            signed = await superDilithium.sign(
                bufMessage,
                this.signingKeyPair.privateKey,
                bufAdditionalData,
            )
        } else {
            signed = await superDilithium.sign(
                bufMessage,
                this.signingKeyPair.privateKey,
            )
        }
        return signed
    }

    async combinedVerify(
        signed: Uint8Array,
        publicKey: Uint8Array,
        additionalData: string = null,
    ): Promise<Uint8Array> {
        let verifyData: Uint8Array
        if (additionalData) {
            let bufAdditionalData = Buffer.from(additionalData, "utf8")
            verifyData = await superDilithium.open(
                signed,
                publicKey,
                bufAdditionalData,
            )
        } else {
            verifyData = await superDilithium.open(signed, publicKey)
        }
        return verifyData
    }

    async sign(
        message: string | Uint8Array,
        additionalData: string | Uint8Array = null,
    ) {
        if (typeof message === "string") {
            message = Buffer.from(message, "utf8")
        }
        if (typeof additionalData === "string") {
            additionalData = Buffer.from(additionalData, "utf8")
        }
        // Signing
        let signed: Uint8Array
        if (additionalData) {
            signed = await superDilithium.signDetached(
                message,
                this.signingKeyPair.privateKey,
                additionalData,
            )
        } else {
            signed = await superDilithium.signDetached(
                message,
                this.signingKeyPair.privateKey,
            )
        }
        return signed
    }

    async verify(
        signature: Uint8Array,
        message: string | Uint8Array,
        publicKey: Uint8Array,
        additionalData: string | Uint8Array = null,
    ) {
        if (typeof message === "string") {
            message = Buffer.from(message, "utf8")
        }
        if (typeof additionalData === "string") {
            additionalData = Buffer.from(additionalData, "utf8")
        }
        // Verifying
        let verified: boolean
        if (additionalData) {
            verified = await superDilithium.verifyDetached(
                signature,
                message,
                publicKey,
                additionalData,
            )
        } else {
            verified = await superDilithium.verifyDetached(
                signature,
                message,
                publicKey,
            )
        }
        return verified
    }

	async exportSigningKeys(passphrase: string = null): Promise<any> {
		let storage: any 
		if (passphrase) {
            storage = await superDilithium.exportKeys(this.signingKeyPair, passphrase)
        } else {
            storage = await superDilithium.exportKeys(this.signingKeyPair)
        }
		return storage
    }

	async importSigningKeys(storage: any, passphrase: string = null): Promise<any> {
		if (passphrase) {
            this.signingKeyPair = await superDilithium.importKeys(storage, passphrase)
        } else {
            this.signingKeyPair = await superDilithium.importKeys(storage)
        }
        return this.signingKeyPair
	}

	/* SECTION Encryption / Decryption with McEliece */
	async generateSecrets(peerPublicKey: any) {
		let {key, encryptedKey} = await this.kem.generateKey(peerPublicKey)
        let normalizedResult = {
            secret: key,
            shared: encryptedKey,
        }
		return normalizedResult
	}

	async deriveSharedSecret(shared: any) {
		let secret = await this.kem.decryptKey(this.mcelieceKeypair.privateKey, shared)
		return secret
	}

    // TODO Encryption?
}
