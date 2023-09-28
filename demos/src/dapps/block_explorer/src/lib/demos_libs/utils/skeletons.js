
// INFO An empty transaction
const transaction = {
	content: {
		type: '', // string
		from: null, // forge.pki.ed25519.BinaryBuffer
		to: null, // forge.pki.ed25519.BinaryBuffer
		amount: 0, // number
		data: ['', ''], // [string, string] // type as string and content in hex string
		nonce: 0, // number // Increments every time a transaction is sent from the same account
		timestamp: 0, // number // Is the registered unix timestamp when the transaction was sent the first time
		transaction_fee: {
			network_fee: 0,
			rpc_fee: 0,
			additional_fee: 0
		}
	},
	signature: null, // pki.ed25519.BinaryBuffer
	hash: null, // string
	confirmations: [], // Confirmation[]
	state_changes: [] // StateChange[]
}

// INFO An empty crosschain operation object
const crosschain_operation = {
	chain: null,
	subchain: null,
	is_evm: null,
	rpc: null,
	task: {
		type: null,
		params: {},
		signedPayloads: []
	},
	//signedPayloads: []
}

// INFO An empty web2 request object
const web2_request = {
	content: {
		action: null,
		parameters: [],
		requestedParameters: null, // Means all
		method: null,
		url: null,
		headers: null,
		minAttestations: null,
		// Handling the various stages of an IWeb2Request
		stage: {
			// The one that will handle the response too
			origin: {
				identity: null,
				connection_url: null
			},
			// Starting from 0, each attestation it is increased
			hop_number: null
		}
	},
	result: null,
	attestations: new Map(),
	hash: null,
	signature: null
}

export { transaction, crosschain_operation, web2_request }