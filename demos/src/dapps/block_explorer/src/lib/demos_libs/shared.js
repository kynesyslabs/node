// INFO A singleton managing various shared states of the sdk
import * as forge from 'node-forge'

export default class SharedState {
	 constructor() {
		this.instance = null;
		this.identity = null;
	 }

	 static getInstance() {
		if (!this.instance) {
            this.instance = new SharedState();
        }
		return this.instance;
	}

	// INFO Accessing identity if set
	async getIdentity() {
		return this.identity;
	}

	// INFO Managing identity in the DEMOS network
	// NOTE Expecting a hex string that will be buffered
	async setIdentity(privateKeyString) {
		let privateKey = Buffer.from(privateKeyString, 'hex');
		this.identity.privateKey = privateKey;
		this.identity.publicKey = forge.pki.ed25519.publicKeyFromPrivateKey(privateKey)
    }

}