// INFO This class is used by web2.js to store, retrieve and manipulate web2 data
let { Peer } = require("./classes/peers.js");
let identity = require("./identity.js");

class Web2Data {
	constructor() {
        this.data = {
			request: { timestamp: null, status: null },
			response: { timestamp: null, result: null, hash: null },
            operator: new Peer(),
		}; // { request: { timestamp, status }, response: { timestamp, result, hash}, operator: Peer object of the node  that retrieved the data }
		this.witnesses = {}; // A dict of nodes that validated the same data {public key: { response: { Peer object, timestamp, hash }, signature: response hash }}
		this.data_signature = null; // Final signature of data field
		this.witnesses_signature = null; // Final signature of witnesses field
	}

	// INFO Fill with the signature of the data field
	async signData(privateKey) {
		this.data_signature = await identity.generate.ecdsa.sign(JSON.stringify(this.data), privateKey);
    }
	// INFO Fill with the signature of the witnesses field
	async signWitnesses(privateKey) {
        this.witnesses_signature = await identity.generate.ecdsa.sign(JSON.stringify(this.witnesses), privateKey);
    }

}

module.exports = Web2Data;