import Cryptography from "src/libs/crypto/cryptography";
import Hashing from "src/libs/crypto/hashing";
import * as forge from 'node-forge'
import { Message } from '../src/features/messaging/message';
import { Hash } from "crypto";

export interface Letter {
	from: string;
	to: string;
	replyToHash: string;
	data: Buffer;
}

export interface MessageContent {
	content: Letter;
	hash: string;
	signature: forge.pki.ed25519.BinaryBuffer;
}

export default class E2ES {

	decrypted: Letter
	encrypted: MessageContent

	constructor() {
		this.decrypted = null
		this.encrypted = null
	}

	async signAndEncrypt(message: Letter, privateKey: forge.pki.ed25519.BinaryBuffer, rsa_public_key: forge.pki.rsa.PublicKey ): Promise<void> {
		this.encrypted.content = await Cryptography.encrypt(this.decrypted, rsa_public_key); // TODO Do the function
		this.decrypted = null
		this.encrypted.hash = Hashing.sha256(JSON.stringify(this.encrypted.content))
		this.encrypted.signature = Cryptography.sign(this.encrypted.hash, privateKey)
	}

	async checkAndDecrypt(rsa_private_key: forge.pki.rsa.PrivateKey, publicKey: forge.pki.ed25519.BinaryBuffer): Promise<[boolean, string]> {
		let signature_verification = Cryptography.verify(this.encrypted.hash, this.encrypted.signature, publicKey)
		if (!signature_verification) return [false, "Signature verification failed"]
		let derived_hash = Hashing.sha256(JSON.stringify(this.encrypted.content))
		if (!(derived_hash===this.encrypted.hash)) return [false, "Hash mismatch"]
		this.decrypted = await Cryptography.decrypt(this.encrypted.content, rsa_private_key)
		return [true, null]
	}

}