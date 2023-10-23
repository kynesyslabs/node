/* eslint-disable no-unused-vars */
// This class represents a typical web2 data request
import * as forge from "node-forge"
import fetch from "node-fetch"
import Cryptography from "src/libs/crypto/cryptography"
import Hashing from "src/libs/crypto/hashing"
import sharedState from "src/utilities/sharedState"
import { PeerManager } from "src/libs/peer"
import required from "src/utilities/required"
import pay from "src/features/multichain/routines/writes/pay"
const term = require("terminal-kit").terminal

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
// NOTE This should be the thing we receive from the handler as a request
// NOTE Basically is the comlink message
export interface IWeb2Payload {
        type: "web2Request",
        message: IWeb2Request,
      sender: any,
      receiver: any,
      timestamp: any,
      data: any,
      extra: any
}


// INFO A complete web2 request
export interface IWeb2Request {
	raw: IRawWeb2Request,
    result: any,
	attestations: {}
	hash: string,
	signature?: forge.pki.ed25519.BinaryBuffer,
}

// INFO A request without any attestations or identity data
export interface IRawWeb2Request {
    action: string,
    parameters: IParam[],
    requestedParameters: [] | null,
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
export default function Web2API (named: string = null, sendSock: any = null, req: IWeb2Payload = null): Web2APIClass {
    let apiInstance: Web2APIClass = Web2APIClass.getInstance(named, sendSock, req)
    return apiInstance
}

// INFO Giving superpowers to the request
export  class Web2APIClass {
    static requests: Map<string, Web2APIClass> = new Map<string, Web2APIClass>()
    static progressive: 0

    // INFO Named singleton (multiton?)
    static getInstance(named: string = null, sendSock: any = null, req: IWeb2Payload = null): Web2APIClass {
        if (!named) { named = String(Web2APIClass.progressive); Web2APIClass.progressive += 1 }
        // Setting the name
        if (!Web2APIClass.requests.has(named)) {
            term.yellow("Creating new Web2API instance\n")
            console.log("Using the following parameters:")
            console.log("\n{Name}")
            console.log(named)
            console.log("\n{Request}")
            console.log(req)
            term.yellow("Proceeding\n")
            required(sendSock, "Missing sender socket")
            required(req, "Missing request")
            Web2APIClass.requests.set(named, new Web2APIClass(named, sendSock, req))
        }
        return Web2APIClass.requests.get(named)
    }

    // NOTE Storing the request here
    payload: IWeb2Payload = null
    request: IWeb2Request = null
    // NOTE Storing the sender's socket here
    senderSocket: null
    // NOTE Index of the request
    name = null

    // INFO Creating a named instance and bootstrapping it
    constructor(name: string, sendSock: any, payload: IWeb2Payload = null) {
        this.name = name
        this.senderSocket = sendSock
        if (!payload.message) {
            console.log("[Web2API] No request attached. Is this right?")
            console.log(payload)
            this.request.raw.minAttestations = 10
            this.request.raw.stage.hop_number = 0
        } else {
            this.payload = payload
            this.request = payload.message
        }
        // REVIEW Should be ok anyway
        // NOTE Not awaiting cause we need to let devs decide when to await with awaitQuorum
        this.digest()
    }

    // INFO Getting the digest of the request
    private async digest(): Promise<IWeb2Request> {
        required(this.request, "Missing request")
        console.log("[ACTUAL REQUEST]")
        console.log(this.request)
        let {action} = this.request.raw 
        let params = this.request.raw.parameters
        // NOTE Dispatching the request to the appropriate handler
        term.yellow("Action: " + action + "\n")
        switch (action) {
            case "GET": // Handling everything that we can handle with fetch
                console.log("HTTP(S) ACTION")
                this.request.result = await this.retrieve(this.request.raw)
                break
            case "POST":
                term.red("[ERROR] Not implemented yet")
                this.request.result = "Not implemented yet"
                break
            case "PUT":
                term.red("[ERROR] Not implemented yet")
                this.request.result = "Not implemented yet"
                break
            case "DELETE":
                term.red("[ERROR] Not implemented yet")
                this.request.result = "Not implemented yet"
                break
            case "PATCH":
                term.red("[ERROR] Not implemented yet")
                this.request.result = "Not implemented yet"
                break
            case "IPFS":
                term.red("[ERROR] Not implemented yet")
                this.request.result = "Not implemented yet"
                // TODO
                break
            default: 
                term.red("[ERROR] Invalid action: " + action + "\n")
                this.request.result = "Invalid action: " + action
                break
        }
        // Building our own attestation
        let hashedResult = Hashing.sha256(JSON.stringify(this.request.result))
        let ourIdentity = sharedState.getInstance().identity.ed25519.publicKey
        let signatureResult = Cryptography.sign(hashedResult, ourIdentity)
        let attestation: IWeb2Attestation = {
            hash: hashedResult,
            timestamp: Date.now(),
            identity: ourIdentity,
            signature: signatureResult,
            valid: true,
        }
        // Adding the attestation to the request
        // NOTE This does not overwrite the original properties of the request
        console.log(this.request)
        this.request.attestations[ourIdentity.toString("hex")] = attestation
        return this.request
    }

    // INFO Experimental a new approach to requests
    private async retrieve(raw_request: IRawWeb2Request): Promise<any> {
        let params: IParam[] = raw_request.parameters
        let url = raw_request.url
        // Url normalization
        if (url.includes("?")) {
            url = url.split("?")[0]
        }
        if (!(url.endsWith("/"))) {
            url += "/"
        }
        // If we have parameters, add them to the request
        if (params.length > 0) {
            let param_string = params.map(param => param.name + "=" + param.value).join("&")
            url += "?" + param_string
        }
        // NOTE Now we should have a normalized url, so we can make the request
        let fetched = await fetch(
            url,
            { method: raw_request.method,
            headers: raw_request.headers,
            // NOTE The following line selectively sets the body to null if the method is not POST
            // and look for the "data" parameter in the parameters array if the method is POST
            // TODO Handle the case where the method is POST but no "data" parameter is present
            body: raw_request.method === "POST"? JSON.stringify(raw_request.parameters["data"]) : null},
        )
        let string_result = JSON.stringify(fetched.json()) // Anyway...
        // Using the fetched result to build (or to continue) the Web2Request
        this.validate(string_result)
        // TODO (Also in validate) manage the case where we are not the first hop
        return fetched
    }


    // INFO Fetching (via different methods) an url and attesting it in this.request
    private async _retrieve(raw_request: IRawWeb2Request, body: any = null, headers: any = {}) {        
        // TODO Scope with special params
        // TODO Implement body params on POST
        // TODO Implement headers
        let params: IParam[] = raw_request.parameters
        // REVIEW Test the fix to the mempool.ts related error (?)
        let fetched: any
        let timeout = 5000 // REVIEW Make it customizable
        //  REVIEW fetch the url better with more customization if possible
        fetched = await fetch(
            this.request.raw.url, { 
                method: this.request.raw.method,
                body: body,// For POST stuff
                headers: headers, // like { 'Content-Type': 'application/json' }
                signal: AbortSignal.timeout(timeout), 
            },
        )
        return fetched // "Not implemented yet"
        // REVIEW How to handle timeouts?
        // Stamping the result
        //await this.validate(JSON.stringify(fetched.json))
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
        this.request.attestations[hex_key] = attestation
        // And the content too
        // REVIEW If we are not the first hop, we should not overwrite the original result
        /*
         * The questionable logic is that the .result property should be lazy static, that means
         * that it should be set only when it is actually needed (aka at the beginning) but
         * is not really protected as there is no advantage of editing it in the middle of the process.
         * 
         * At the end of the process, the result is anyway compared with the various attestations
         * within the validators array.
         * 
        */
        if (this.request.result === undefined) {
            this.request.result = content
        }
        //this.request.result = content
    }


    // INFO Verifying this.request based on the attestations
    async verify(): Promise<boolean> {
        required(this.request, "Missing request")
        let valid = true
        // Cycling through all the attestations
        for (let key of Object.keys(this.request.attestations)) {
            let attestation = this.request.attestations[key]
            // REVIEW Checking the hash validity for all the attestations
            let stringifiedContent = JSON.stringify(this.request.raw)
            let hash = Hashing.sha256(stringifiedContent)
            let hash_valid = hash===attestation.hash
            // REVIEW Checking the signature validity for all the attestations
            let signature_valid = Cryptography.verify(
                attestation.signature.toString("hex"),
                attestation.hash,
                attestation.identity)
            // Noting the result of the verification in the attestation array
            let isValid = hash_valid && signature_valid
            attestation.valid = isValid
            this.request.attestations[key] = attestation
        }
        return valid
    }

    // INFO Broadcasting this.request to another peer
    async next(): Promise<void> {
        required(this.request, "Missing request")
        // Selecting a random peer (just one)
        let peerlist = PeerManager.getInstance().getPeers()
        let peer = peerlist[Math.floor(Math.random() * peerlist.length)]
        // Forwarding the request to the selected peer

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
        return Object.keys(this.request.attestations).length
    }

    // INFO Easy awaiter with timeout
    /* NOTE 
     * The role of this method is to help the original rpc receiving the web2 request to
     * wait (with a customizable timeout) for the attestations to arrive.
     * The whole web2 on chain structure is designed to be as much asynchronous as possible,
     * so the receiving rpc needs to be able to wait without blocking all its services.
     * 
     * This method is based on the idea that the original rpc should be agnostic to the
     * actual position of the request in the attestation process, and should only wait for
     * the attestations to arrive.
     * 
    */
    async awaitQuorum(quorum: number = 10, timeout: number = 9000): Promise<boolean> {
        let reachedQuorum: boolean = false
        let timer: number = 0
        // NOTE We wait for timeout seconds before surrendering
        while (timer < timeout) {
            await new Promise((resolve) => setTimeout(resolve, 100)) // Each 100 ms we can check for updates
            if (this.getAttestationsNumber() >= quorum) {
                reachedQuorum = true
                break
            }
            timer += 100
        }
        return reachedQuorum
    }
    // !SECTION Status controls
}