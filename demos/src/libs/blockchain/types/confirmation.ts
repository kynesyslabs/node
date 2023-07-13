import forge from 'node-forge';

export default class Confirmation {
	data: {
		validator: forge.pki.ed25519.BinaryBuffer
		tx_hash_validated: string
	}
	signature: forge.pki.ed25519.BinaryBuffer
}