// This class represents a typical web2 data request
import * as forge from "node-forge"
import fetch from "node-fetch"
import Cryptography from "src/libs/crypto/cryptography"
import Hashing from "src/libs/crypto/hashing"
import sharedState from "src/utilities/sharedState"
import required from "src/utilities/required"
import { Server as ServerType } from "socket.io"

AbortSignal.timeout ??= function timemout(ms) {
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), ms)
    return ctrl.signal
}

// INFO Properties of a typical request as the client would send it
export interface IWeb2Request {
	content: {
		action: string,
		url: string,
		headers: any,
		minAttestations: number,
		// Handling the various stages of an IWeb2Request
		stage: {
			// The one that will handle the response too
			origin: {
				identity: forge.pki.ed25519.BinaryBuffer,
				connection_url: string,
			},
			// Starting from 0, each attestation it is increased
			hop_number: number,
		}
	},
	attestations: Map<string, IWeb2Attestation>,
	hash: string,
	signature?: forge.pki.ed25519.BinaryBuffer,
}

// ANCHOR Useful interfaces
export interface IWeb2Attestation {
	hash: string,
	timestamp: number,
	identity: forge.pki.PublicKey,
	signature: forge.pki.ed25519.BinaryBuffer,
}

// INFO Giving superpowers to the request
export default class Web2API {
    // NOTE Storing the request here
    request: IWeb2Request = null
    // NOTE Storing the sender's socket here
    senderSocket: null

    constructor(sendSock: any, req: IWeb2Request = null) {
        this.senderSocket = sendSock
        if (!req) {
            this.request.content.minAttestations = 10
            this.request.content.stage.hop_number = 0
        }
        else this.request = req
    }

    // INFO Fetching an url and attesting it in this.request
    async attest(): Promise<IWeb2Request> {
        required(this.request, "Missing request")
        let fetched
        let timeout = 5000 // REVIEW Make it customizable
        //  REVIEW fetch the url better with more customization if possible
        fetched = await fetch(
            this.request.content.url, { 
                method: "GET",
                body: null, // For POST stuff
                headers: {}, // like { 'Content-Type': 'application/json' }
                signal: AbortSignal.timeout(timeout), 
            },
        )
        // TODO How to handle timeouts?
        // Hashing and signing the result
        // TODO Implement variable scoping
        let hashed_result = Hashing.sha256(JSON.stringify(fetched.json))
        this.request.hash = hashed_result
        let signature = Cryptography.sign(
            hashed_result, 
            sharedState.getInstance().identity.ed25519.privateKey)
        this.request.signature = signature
        // Composing our attestation
        let attestation: IWeb2Attestation = {
            hash: hashed_result,
            timestamp: Date.now(),
            identity: sharedState.getInstance().identity.ed25519.publicKey,
            signature: signature,
        }
        // Adding the attestation to the request
        let hex_key = sharedState.getInstance().identity.ed25519.publicKey.toString("hex") // REVIEW Is this ok?
        this.request.attestations.set(hex_key, attestation)
        return this.request
    }


    // INFO Verifying this.request based on the attestations
    async verify(): Promise<boolean> {
        required(this.request, "Missing request")
        let valid = true
        // TODO Checking the hash validity for all the attestations
        // TODO Checking the signature validity for all the attestations
        return valid
    }

    // INFO Broadcasting this.request to another peer
    async next(): Promise<void> {
        required(this.request, "Missing request")
        // TODO Send the request to the next peer
    }

    // INFO Sending this.request response to the origin
    async reply(): Promise<void> {
        required(this.request, "Missing request")
        // TODO Send the response to the origin
    }
}