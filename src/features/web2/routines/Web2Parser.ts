import Cryptography from "src/libs/crypto/cryptography"
import Hashing from "src/libs/crypto/hashing"
import { PeerManager } from "src/libs/peer"
import required from "src/utilities/required"
import sharedState from "src/utilities/sharedState"
import terminalKit from "terminal-kit"

import {
    IRawWeb2Request,
    IWeb2Attestation,
    IWeb2Request,
    IWeb2Result,
} from "@kynesyslabs/demosdk/types"

import post from "./operations/Web2Post"
import retrieve from "./operations/Web2Retrieve"

const term = terminalKit.terminal

/**
 * Adds a timeout method to the AbortSignal if it doesn't already exist.
 * The timeout method creates a new AbortController and sets a timeout to abort it after a specified number of milliseconds.
 * @param {number} ms - The number of milliseconds to wait before aborting the AbortController.
 * @returns {AbortSignal} The AbortSignal from the created AbortController.
 */
AbortSignal.timeout ??= function timeout(ms) {
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), ms)
    return ctrl.signal
}

/**
 * Function to manage instances of the Web2APIClass.
 * It can either remove an instance or get an instance based on the provided parameters.
 *
 * @param {string} command - The command to execute. If it's "remove", the function will remove an instance.
 * @param {string} named - The name of the instance to get or remove.
 * @param {any} sendSock - The sender socket. If the command is "remove", this should be the name of the instance to remove.
 * @param {IWeb2Request} req - The request to use when getting an instance.
 * @returns {Web2APIClass} The instance of the Web2APIClass, if the command is not "remove".
 * @export
 * @default
 */

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

    const apiInstance: Web2APIClass = Web2APIClass.getInstance(
        named,
        sendSock,
        req,
    )
    return apiInstance
}

/**
 * Class representing a Web2API.
 * @class
 */
export class Web2APIClass {
    /**
     * A map of requests.
     * @type {Map<string, Web2APIClass>}
     * @static
     */
    static requests: Map<string, Web2APIClass> = new Map<string, Web2APIClass>()

    /**
     * A progressive counter.
     * @type {number}
     * @static
     */
    static progressive: 0

    /**
     * Get an instance of the class.
     * @param {string} named - The name of the instance.
     * @param {any} sendSock - The sender socket.
     * @param {IWeb2Request} req - The request.
     * @returns {Web2APIClass} The instance of the class.
     * @static
     */
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

            required(sendSock, "[Web2APIClass] Missing sender socket")
            required(req, "[Web2APIClass] Missing request")
            Web2APIClass.requests.set(
                named,
                new Web2APIClass(named, sendSock, req),
            )
        }
        return Web2APIClass.requests.get(named)
    }

    /**
     * The request.
     * @type {IWeb2Request}
     */
    request: IWeb2Request = null

    /**
     * The sender's socket.
     * @type {any}
     */
    senderSocket: null

    /**
     * The name of the request.
     * @type {string}
     */
    name = null

    /**
     * The digested promise.
     * @type {Promise<any>}
     */
    digestedPromise: Promise<any> = null

    /**
     * Create a named instance of the class and bootstrap it.
     * @param {string} name - The name of the instance.
     * @param {any} sendSock - The sender socket.
     * @param {IWeb2Request} payload - The request.
     */
    constructor(name: string, sendSock: any, payload: IWeb2Request = null) {
        this.name = name
        this.senderSocket = sendSock
        if (!payload.raw) {
            term.yellow.bold(
                "[Web2API] No raw request attached. Is this right?",
            )
            // TODO Specify this as a parameter that users can set
            this.request.raw.minAttestations = 10
            this.request.raw.stage.hopNumber = 0
        } else {
            this.request = payload
        }
        // REVIEW Should be ok anyway
        // NOTE Not awaiting cause we need to let devs decide when to await with awaitQuorum
        this.digestedPromise = this.digest()
    }

    /**
     * Remove an instance of the class.
     * @param {string} named - The name of the instance.
     * @static
     */
    static removeInstance(named: string): void {
        if (Web2APIClass.requests.has(named)) {
            Web2APIClass.requests.delete(named)
            console.log(`Instance named ${named} removed successfully.`)
        } else {
            console.log(`No instance found with the name ${named}.`)
        }
    }

    /**
     * Main method for Web2 workflow. This is where the Web2Request is processed and the answer is created
     * @returns {Promise<IWeb2Request>} The processed request.
     * @private
     */
    private async digest(): Promise<IWeb2Request> {
        required(this.request, "Missing request")
        console.log("[ACTUAL REQUEST]")
        const { action } = this.request.raw
        const params = this.request.raw.parameters
        // NOTE Dispatching the request to the appropriate handler
        term.yellow("Action: " + action + "\n")
        // Preparing the result variable
        let rawResult: IWeb2Result
        switch (action) {
            case "GET": // Handling everything that we can handle with fetch
                console.log("HTTP(S) GET ACTION")
                rawResult = await this.retrieve(this.request.raw)
                this.request.result = rawResult
                break
            case "POST":
                console.log("HTTP(S) POST ACTION")
                rawResult = await this.post(this.request.raw)
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
        // Also note that the result is modified within the object in this.validate(rawResult)
        term.yellow(
            "[Web2Parser] Building our attestation and adding it to request\n",
        )
        const validationSuccess = await this.validate(rawResult)
        term.yellow.bold("[Web2Parser] Attested: " + validationSuccess + "\n")
        // Now we can return the class result as the request is processed on our side
        term.yellow("[Web2Parser] Digested:\n")
        console.log(this.request)
        this.request.raw.stage.hopNumber += 1 // REVIEW If this is ok
        return this.request
    }

    /**
     * Retrieve the resource from the raw request.
     * @type {(raw_request: IRawWeb2Request) => Promise<IWeb2Result>}
     */
    retrieve: (raw_request: IRawWeb2Request) => Promise<IWeb2Result> = retrieve

    /**
     * Post the raw request.
     * @type {(raw_request: IRawWeb2Request) => Promise<IWeb2Result>}
     */
    post: (raw_request: IRawWeb2Request) => Promise<IWeb2Result> = post

    /**
     * Validate the content.
     * @param {IWeb2Result} content - The content to validate.
     * @returns {Promise<boolean>} Whether the content is valid.
     */
    async validate(content: IWeb2Result): Promise<boolean> {
        term.yellow.bold("[Web2Parser] Validating...\n")
        const stringedContent = JSON.stringify(content)
        // REVIEW This is not the best way to do it
        // Hashing and signing the result
        const hashedResult = Hashing.sha256(stringedContent)
        this.request.hash = hashedResult
        term.bold("[Web2Parser] Result:\n")
        console.log(hashedResult)
        const signature = Cryptography.sign(
            hashedResult,
            sharedState.getInstance().identity.ed25519.privateKey,
        )
        this.request.signature = signature
        term.bold("[Web2Parser] Signature:\n")
        //console.log(signature)
        // Composing our attestation
        const attestation: IWeb2Attestation = {
            hash: hashedResult,
            timestamp: Date.now(),
            identity: sharedState.getInstance().identity.ed25519.publicKey,
            signature: signature,
            valid: null,
        }
        term.bold("[Web2Parser] Attestation:\n")
        //console.log(attestation)
        // Adding the attestation to the request
        const hexKey = sharedState
            .getInstance()
            .identity.ed25519.publicKey.toString("hex") // REVIEW Is this ok?
        this.request.attestations[hexKey] = attestation
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

    /**
     * Verify the request based on the attestations. Checking attestations (one by one) and returning the result of the verification
     * @returns {Promise<boolean>} Whether the request is valid.
     */
    async verify(): Promise<boolean> {
        required(this.request, "Missing request")
        let valid = true
        // Cycling through all the attestations
        for (const key of Object.keys(this.request.attestations)) {
            const attestation = this.request.attestations[key]
            // REVIEW Checking the hash validity for all the attestations
            const stringifiedContent = JSON.stringify(this.request.raw)
            const hash = Hashing.sha256(stringifiedContent)
            const hashIsValid = hash === attestation.hash
            // REVIEW Checking the signature validity for all the attestations
            const signatureIsValid = Cryptography.verify(
                attestation.signature.toString("hex"),
                attestation.hash,
                attestation.identity,
            )
            // Noting the result of the verification in the attestation array
            const isValid = hashIsValid && signatureIsValid
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

    /**
     * Broadcast the request to another peer.
     */
    async next(): Promise<void> {
        required(this.request, "Missing request")
        // Selecting a random peer (just one)
        const peerList = PeerManager.getInstance().getPeers()
        const peer = peerList[Math.floor(Math.random() * peerList.length)]
        // Forwarding the request to the selected peer

        // TODO Send the request to the next peer
    }

    /**
     * Send the request response to the origin.
     */
    async reply(): Promise<void> {
        required(this.request, "Missing request")
        // TODO Send the response to the origin
    }

    // SECTION Status controls
    /**
     * Get the number of attestations.
     * @returns {number} The number of attestations.
     */
    getAttestationsNumber(): number {
        return Object.keys(this.request.attestations).length
    }

    /**
     * Wait for the attestations to arrive. The role of this method is to help the original rpc 
     * receiving the web2 request to wait (with a customizable timeout) for the attestations to 
     * arrive. The whole web2 on chain structure is designed to be as much asynchronous as possible,
     * so the receiving rpc needs to be able to wait without blocking all its services.
     *
     * This method is based on the idea that the original rpc should be agnostic to the
     * actual position of the request in the attestation process, and should only wait for
     * the attestations to arrive.
     * @param {number} quorum - The quorum.
     * @param {number} timeout - The timeout.
     * @returns {Promise<boolean>} Whether the quorum is reached.
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
