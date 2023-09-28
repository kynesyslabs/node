import DemosWebAuth from './DemosWebAuthenticator.js';
import * as skeletons from './utils/skeletons.js';
import bufferize from './utils/bufferizer';
import sha256 from './utils/sha256';
import forge from 'node-forge';

export const DemosTransactions = {
	// REVIEW All this part
	// NOTE A courtesy to get a skeleton of transactions
	empty: function () {
		return skeletons.transaction;
	},
	// NOTE Building a transaction without signing or hashing it
	prepare: async function (data) {
		// sourcery skip: inline-immediately-returned-variable
		let thisTx = skeletons.transaction;
		//if (!data.timestamp) data.timestamp = Date.now()
		// Assigning the transaction data to our object
		//thisTx.content = data
		return thisTx;
	},
	// NOTE Signing a transaction after hashing it
	sign: async function (raw_tx, private_key = null) {
		// If necessary, the private key is loaded from the state
		if (!private_key) {
			let id = DemosWebAuth.getInstance().keypair;
			private_key = id.privateKey;
			console.log('Private key loaded from state');
		} else {
			console.log('Private key provided');
		}
		console.log(private_key);
		// Hashing the content of the transaction
		//let md = forge.md.sha256.create()
		//md.update(JSON.stringify(raw_tx.content))
		raw_tx.hash = await sha256(raw_tx.content);
		// Signing the hash of the content
		raw_tx.signature = forge.pki.ed25519.sign({
			message: raw_tx.hash,
			encoding: 'utf8',
			privateKey: private_key
		}); // REVIEW if it is working right
		raw_tx.signature = bufferize(Buffer.from(raw_tx.signature)); // FIXME Changed to Buffer
		return raw_tx; // Hashed and signed
	},
	// NOTE Sending a transaction after signing it
	broadcast: async function (signed_tx) {
		// TODO: Implement and for god sake do some error handling
		return await demos.call('tx', { tx: signed_tx }); // REVIEW It should returns either false + error or true + hash
	}
};
