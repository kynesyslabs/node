// This class represents a typical web2 data request
import * as forge from "node-forge"
import fetch from "node-fetch"
import Cryptography from "src/libs/crypto/cryptography"
import Hashing from "src/libs/crypto/hashing"
import sharedState from "src/utilities/sharedState"
import required from "src/utilities/required"

AbortSignal.timeout ??= function timemout(ms) {
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), ms)
    return ctrl.signal
}

export interface IParam {
    name: string
    value: any
}

// INFO Properties of a typical request as the client would send it
export interface IWeb2Request {
	content: {
		action: string,
        parameters: IParam[],
        method: "POST" | "GET" | "PUT" | "DELETE" | "PATCH",
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
    result: any,
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
    valid: boolean,
}

// INFO Simply handles the singleton stuff
export default function Web2API (named: string = null, sendSock: any = null, req: IWeb2Request = null): Web2APIClass {
    let apiInstance: Web2APIClass = Web2APIClass.getInstance(named, sendSock, req)
    return apiInstance
}

// INFO Giving superpowers to the request
export  class Web2APIClass {
    static requests: Map<string, Web2APIClass> = new Map<string, Web2APIClass>()
    static progressive: 0

    // INFO Named singleton (multiton?)
    static getInstance(named: string = null, sendSock: any = null, req: IWeb2Request = null): Web2APIClass {
        if (!named) { named = String(Web2APIClass.progressive); Web2APIClass.progressive += 1 }
        // Setting the name
        if (!Web2APIClass.requests.has(named)) {
            required(sendSock, "Missing sender socket")
            required(req, "Missing request")
            Web2APIClass.requests.set(named, new Web2APIClass(named, sendSock, req))
        }
        return Web2APIClass.requests.get(named)
    }

    // NOTE Storing the request here
    request: IWeb2Request = null
    // NOTE Storing the sender's socket here
    senderSocket: null
    // NOTE Index of the request
    name = null

    // INFO Creating a named instance and bootstrapping it
    constructor(name: string, sendSock: any, req: IWeb2Request = null) {
        this.name = name
        this.senderSocket = sendSock
        if (!req) {
            this.request.content.minAttestations = 10
            this.request.content.stage.hop_number = 0
        } else {
            this.request = req
        }
        // REVIEW Should be ok anyway
        // NOTE Not awaiting cause we need to let devs decide when to await with awaitQuorum
        this.digest()
    }

    // INFO Getting the digest of the request
    private async digest(): Promise<IWeb2Request> {
        required(this.request, "Missing request")
        let {action} = this.request.content
        let params = this.request.content.parameters
        // NOTE Dispatching the request to the appropriate handler
        switch (action) {
            case "HTTP": // Handling everything that we can handle with fetch
                this.request.result = await this.retrieve(params)
                break
            default: break
        }
        return this.request
    }


    // INFO Fetching (via different methods) an url and attesting it in this.request
    private async retrieve(params: IParam[] = null) {
        // TODO Scope with special params
        // TODO Implement body params on POST
        // TODO Implement headers
        let fetched: any
        let timeout = 5000 // REVIEW Make it customizable
        //  REVIEW fetch the url better with more customization if possible
        fetched = await fetch(
            this.request.content.url, { 
                method: this.request.content.method,
                body: null, // For POST stuff
                headers: {}, // like { 'Content-Type': 'application/json' }
                signal: AbortSignal.timeout(timeout), 
            },
        )
        // REVIEW How to handle timeouts?
        // Stamping the result
        await this.validate(JSON.stringify(fetched.json))
    }

    // INFO This method inserts validation data into the request
    async validate(content: string): Promise<void> {
        // Hashing and signing the result
        let hashed_result = Hashing.sha256(content)
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
            valid: null,
        }
        // Adding the attestation to the request
        let hex_key = sharedState.getInstance().identity.ed25519.publicKey.toString("hex") // REVIEW Is this ok?
        this.request.attestations.set(hex_key, attestation)
        // And the content too
        this.request.result = content
    }


    // INFO Verifying this.request based on the attestations
    async verify(): Promise<boolean> {
        required(this.request, "Missing request")
        let valid = true
        // Cycling through all the attestations
        for (let [key, attestation] of this.request.attestations) {
            // REVIEW Checking the hash validity for all the attestations
            let stringifiedContent = JSON.stringify(this.request.content)
            let hash = Hashing.sha256(stringifiedContent)
            let hash_valid = hash===attestation.hash
            // REVIEW Checking the signature validity for all the attestations
            let signature_valid = Cryptography.verify(
                attestation.signature.toString("hex"),
                attestation.hash,
                attestation.identity)
            // Noting the result of the verification in the attestation array
            let isValid = hash_valid && signature_valid
            // sourcery skip: dont-self-assign-variables
            attestation.valid = isValid
            this.request.attestations.set(key, attestation)
        }
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

    // SECTION Status controls
    // INFO Easy handler for this info
    getAttestationsNumber(): number {
        return this.request.attestations.size
    }

    // INFO Easy awaiter with timeout
    async awaitQuorum(quorum: number = 10, timeout: number = 9000): Promise<boolean> {
        let reachedQuorum: boolean = false
        let timer: number = 0
        // NOTE We wait for timeout seconds before surrendering
        while (timer < timeout) {
            await new Promise((resolve) => setTimeout(resolve, 100)) // Each 100 ms we can check for updates
            if (this.request.attestations.size >= quorum) {
                reachedQuorum = true
                break
            }
            timer += 100
        }
        return reachedQuorum
    }
    // !SECTION Status controls
}