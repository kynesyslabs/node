// INFO This module exposes methods to quickly send Web2 requests to the network

import * as skeletons from "./utils/skeletons.js"
import demos from "../demos.js";

// INFO Web2 Endpoints
export default async function Web2Transactions(
		action = "GET",
		url = "https://icanhazip.com",
		parameters = [],
		requestedParameters = null,
		headers = null,
		minAttestations = 2,
	) {
	// Generating an empty one and filling it
	let request = skeletons.web2_request;
	request.content.action = action
	request.content.url = url
	request.content.parameters = parameters
	request.content.headers = headers
	request.content.minAttestations = minAttestations
	// Ensuring content is a known property
	request.attestations = new Map();
	request.hash = undefined
	request.signature = undefined
	request.result = undefined

	let web2 = await demos.call("web2Request", request)
	web2 = JSON.parse(web2);
	return web2;
}