import axios from "axios"
/* eslint-disable no-unused-vars */
import forge from "node-forge"
import Cryptography from "src/libs/crypto/cryptography"
import Hashing from "src/libs/crypto/hashing"
import { PeerManager } from "src/libs/peer"
import required from "src/utilities/required"
import sharedState from "src/utilities/sharedState"
// NOTE Terminal kit for useful logging
import terminalkit from "terminal-kit"

import {
    IParam, IRawWeb2Request, IWeb2Attestation, IWeb2Payload, IWeb2Request, IWeb2Result,
} from "@kynesyslabs/demosdk/types"

import post from "./operations/Web2Post"
import retrieve from "./operations/Web2Retrieve"

const term = terminalkit.terminal

AbortSignal.timeout ??= function timemout(ms) {
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), ms)
    return ctrl.signal
}

// INFO Simply handles the singleton stuff
export default function Web2API(
    command: string = null,
    named: string = null,
    sendSock: any = null,
    req: IWeb2Request = null,
): Web2APIClass {
    if (command === "remove" && typeof sendSock === "string") {
        const instanceNameToRemove = sendSock
        Web2APIClass.removeInstance(instanceNameToRemove)
        return
    }

    let apiInstance: Web2APIClass = Web2APIClass.getInstance(
        named,
        sendSock,
        req,
    )
    return apiInstance
}

// INFO Giving superpowers to the request
export class Web2APIClass {
    static requests: Map<string, Web2APIClass> = new Map<string, Web2APIClass>()
    static progressive: 0

    // INFO Named singleton (multiton?)
    static getInstance(
        named: string = null,
        sendSock: any = null,
        req: IWeb2Request = null,
    ): Web2APIClass {
        if (!named) {
            named = String(Web2APIClass.progressive)
            Web2APIClass.progressive += 1
        }
        // Setting the name
        if (!Web2APIClass.requests.has(named)) {
            term.yellow("[Web2APIClass] Creating new Web2API instance\n")
            //console.log("Using the following parameters:")
            //console.log("\n{Name}")
            //console.log(named)
            //console.log("\n{Request}")
            //console.log(req)
            //term.yellow("Proceeding\n")
            required(sendSock, "[Web2APIClass] Missing sender socket")
            required(req, "[Web2APIClass] Missing request")
            Web2APIClass.requests.set(
                named,
                new Web2APIClass(named, sendSock, req),
            )
        }
        return Web2APIClass.requests.get(named)
    }

    // NOTE Storing the request here
    request: IWeb2Request = null
    // NOTE Storing the sender's socket here
    senderSocket: null
    // NOTE Index of the request
    name = null

    digestedPromise: Promise<any> = null

    // SECTION Control methods

    // INFO Creating a named instance and bootstrapping it
    constructor(name: string, sendSock: any, payload: IWeb2Request = null) {
        this.name = name
        this.senderSocket = sendSock
        console.log(payload)
        if (!payload.raw) {
            term.yellow.bold("[Web2API] No raw request attached. Is this right?")
            //console.log(payload)
            // TODO Specify this as a parameter that users can set
            this.request.raw.minAttestations = 10
            this.request.raw.stage.hop_number = 0
        } else {
            this.request = payload
        }
        // REVIEW Should be ok anyway
        // NOTE Not awaiting cause we need to let devs decide when to await with awaitQuorum
        this.digestedPromise = this.digest()
    }

    static removeInstance(named: string): void {
        if (Web2APIClass.requests.has(named)) {
            Web2APIClass.requests.delete(named)
            console.log(`Instance named ${named} removed successfully.`)
        } else {
            console.log(`No instance found with the name ${named}.`)
        }
    }

    // SECTION Processing methods

    // INFO Processing the request
    // ANCHOR Main method for Web2 workflow
    // NOTE This is where the Web2Request is processed and the answer is created
    // NOTE The generated request.result needs to be attested
    private async digest(): Promise<IWeb2Request> {
        required(this.request, "Missing request")
        console.log("[ACTUAL REQUEST]")
        //console.log(this.request)
        let { action } = this.request.raw
        let params = this.request.raw.parameters
        // NOTE Dispatching the request to the appropriate handler
        term.yellow("Action: " + action + "\n")
        // Preparing the result variable
        let raw_result: IWeb2Result
        switch (action) {
            case "GET": // Handling everything that we can handle with fetch
                console.log("HTTP(S) GET ACTION")
                raw_result = await this.retrieve(this.request.raw)
                this.request.result = raw_result
                break
            case "POST":
                console.log("HTTP(S) POST ACTION")
                raw_result = await this.post(this.request.raw)
                break
            case "PUT":
                term.red("[ERROR] Not implemented yet")
                this.request.result = "Not implemented yet: PUT"
                break
            case "DELETE":
                term.red("[ERROR] Not implemented yet")
                this.request.result = "Not implemented yet: DELETE"
                break
            case "PATCH":
                term.red("[ERROR] Not implemented yet")
                this.request.result = "Not implemented yet: PATCH"
                break
            case "IPFS":
                term.red("[ERROR] Not implemented yet")
                this.request.result = "Not implemented yet: IPFS"
                // TODO
                break
            default:
                term.red("[ERROR] Invalid action: " + action + "\n")
                this.request.result = "Invalid action: " + action
                break
        }
        // NOTE Validating the result and adding the attestation
        // Also note that the result is modified within the object in this.validate(raw_result)
        term.yellow(
            "[Web2Parser] Building our attestation and adding it to request\n",
        )
        let validationSuccess = await this.validate(raw_result)
        term.yellow.bold("[Web2Parser] Attested: " + validationSuccess + "\n")
        // Now we can return the class result as the request is processed on our side
        term.yellow("[Web2Parser] Digested:\n")
        console.log(this.request)
        this.request.raw.stage.hop_number += 1 // REVIEW If this is ok
        return this.request
    }

    // INFO Retrieving the resource from the raw request
    retrieve: (raw_request: IRawWeb2Request) => Promise<IWeb2Result> = retrieve
    post: (raw_request: IRawWeb2Request) => Promise<IWeb2Result> = post

    // SECTION Validation and verification methods

    // INFO This method inserts self validation data into the request
    async validate(content: IWeb2Result): Promise<boolean> {
        term.yellow.bold("[Web2Parser] Validating...\n")
        let stringed_content = JSON.stringify(content)
        // REVIEW This is not the best way to do it
        // Hashing and signing the result
        let hashed_result = Hashing.sha256(stringed_content)
        this.request.hash = hashed_result
        term.bold("[Web2Parser] Result:\n")
        console.log(hashed_result)
        let signature = Cryptography.sign(
            hashed_result,
            sharedState.getInstance().identity.ed25519.privateKey,
        )
        this.request.signature = signature
        term.bold("[Web2Parser] Signature:\n")
        //console.log(signature)
        // Composing our attestation
        let attestation: IWeb2Attestation = {
            hash: hashed_result,
            timestamp: Date.now(),
            identity: sharedState.getInstance().identity.ed25519.publicKey,
            signature: signature,
            valid: null,
        }
        term.bold("[Web2Parser] Attestation:\n")
        //console.log(attestation)
        // Adding the attestation to the request
        let hex_key = sharedState
            .getInstance()
            .identity.ed25519.publicKey.toString("hex") // REVIEW Is this ok?
        this.request.attestations[hex_key] = attestation
        term.bold("[Web2Parser] Added attestation to request\n")
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
        // REVIEW This cant be false tho
        return true
    }

    // INFO Verifying this.request based on the attestations
    // TLDR Checking attestations (one by one) and returning the result of the verification
    async verify(): Promise<boolean> {
        required(this.request, "Missing request")
        let valid = true
        // Cycling through all the attestations
        for (let key of Object.keys(this.request.attestations)) {
            let attestation = this.request.attestations[key]
            // REVIEW Checking the hash validity for all the attestations
            let stringifiedContent = JSON.stringify(this.request.raw)
            let hash = Hashing.sha256(stringifiedContent)
            let hash_valid = hash === attestation.hash
            // REVIEW Checking the signature validity for all the attestations
            let signature_valid = Cryptography.verify(
                attestation.signature.toString("hex"),
                attestation.hash,
                attestation.identity,
            )
            // Noting the result of the verification in the attestation array
            let isValid = hash_valid && signature_valid
            attestation.valid = isValid
            // If the attestation is not valid, the whole request is not valid and while
            // we continue to cycle through the attestations, we can already set the
            // request as not valid
            if (!isValid) {
                valid = false
            }
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
    async awaitQuorum(
        quorum: number = 10,
        timeout: number = 9000,
    ): Promise<boolean> {
        let reachedQuorum: boolean = false
        let timer: number = 0
        // NOTE We wait for timeout seconds before surrendering
        while (timer < timeout) {
            await new Promise(resolve => setTimeout(resolve, 100)) // Each 100 ms we can check for updates
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
