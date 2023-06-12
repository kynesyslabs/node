// INFO This class is used by web2.js to store, retrieve and manipulate web2 data

class Web2Data {
	constructor() {
        this.data = {}; // { request: { timestamp, status }, response: { timestamp, result, hash}, operator: Peer object of the node  that retrieved the data }
		this.witnesses = {}; // A list of nodes that validated the same data { response: { Peer object, timestamp, hash }, signature: public key }
		this.data_signature = null; // Final signature of data field
		this.witnesses_signature = null; // Final signature of witnesses field
	}
	// TODO The system will work as following:
	/*
	 * Once a web2 data request is received, data.request is filled with the timestamp and status of the request (pending)
	 * The node retrieves the data and stores it in data.response with the timestamp and result of the request, then an hash is calculated from the result and stored in data.response.hash
	 * The node register himself as data.operator
	 * The node choose randomly (or not?) some peers (reputation here?) that will retrieve the data again
	 * The peers sends back a response object with their identities, a timestamp and the hash of the retrieved data (that should be equal to data.response.hash)
	 * The peers' response contains a signature field that ensure cryptographically that the data was retrieved correctly by that node
	 * Once all the hashes correspond, the node sign both data and witnesses and returns the answer that is secure and on chain
	*/
}

module.exports = Web2Data;