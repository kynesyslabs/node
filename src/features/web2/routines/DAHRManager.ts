import https from "https"
import httpProxy from "http-proxy"
import terminalKit from "terminal-kit"

import Cryptography from "src/libs/crypto/cryptography"
import Hashing from "src/libs/crypto/hashing"
import { PeerManager } from "src/libs/peer"
import required from "src/utilities/required"
import sharedState from "src/utilities/sharedState"

import {
    IRawWeb2Request,
    IWeb2Attestation,
    IWeb2Request,
    IWeb2Result,
} from "@kynesyslabs/demosdk/types"

const term = terminalKit.terminal

/**
 * DAHRManager is a singleton class that manages DAHR instances.
 */
export class DAHRManager {
    private static instance: DAHRManager
    private static dahrs: Map<string, DAHR>
    /**
     * A static property used as a counter to generate unique session IDs.
     * @type {number}
     */
    private static progressive: 0

    
    /** 
     * The name of the DAHR instance.
     * @type {string}
     */
    dahrName: string
  
    /**
     * Private constructor to prevent direct object creation.
     */
    private constructor() {
        DAHRManager.dahrs = new Map()
    }
  
    /**
     * Get the singleton instance of DAHRManager.
     * @returns {DAHRManager} The singleton instance of DAHRManager.
     */
    static getInstance(): DAHRManager {
        if (!DAHRManager.instance) {
            term.yellow("[DAHRManager] Creating new DAHRManager instance\n")

            DAHRManager.instance = new DAHRManager()
        }
        return DAHRManager.instance
    }
  
    /**
     * Get a DAHR instance by sessionId. If it doesn't exist, create a new one.
     * @param {string} sessionId - The session ID.
     * @returns {DAHR} The DAHR instance.
     */
    getDAHR(sessionId: string = null): DAHR {
        if (!sessionId) {
            sessionId = String(DAHRManager.progressive)
            DAHRManager.progressive += 1
            this.dahrName = sessionId
        }

        if (!DAHRManager.dahrs.has(sessionId)) {
            term.yellow("[DAHRManager] Creating new DAHR instance\n")

            DAHRManager.dahrs.set(sessionId, new DAHR())
        }

        return DAHRManager.dahrs.get(sessionId)
    }

    /**
     * Delete a DAHR instance by sessionId.
     * @param {string} sessionId - The session ID.
     */
    deleteDAHR(sessionId: string): void {
        if (DAHRManager.dahrs.has(sessionId)) {
            DAHRManager.dahrs.delete(sessionId)
            console.log(`Instance sessionId ${sessionId} removed successfully.`)
        } else {
            console.log(`No instance found with the name ${sessionId}.`)
        }
    }
  
    /**
     * Get all DAHR instances.
     * @returns {Array<[string, DAHR]>} An array of DAHR instances.
     */
    getAllDAHRs(): Array<[string, DAHR]> {
      return Array.from(DAHRManager.dahrs)
    }
  }

class DAHR {
    private proxy: Proxy

    /**
     * Initialize a DAHR instance.
     * @param {string} source - The source.
     * @param {string} target - The target.
     */
    initializeDAHR(source: string, target: string) {
        this.proxy = new Proxy(source, target)
    }

    /**
     * Talk with the target.
     * @returns {Promise<any>} The attested result.
     */
    async talkWithTarget(path: string, body: IRawWeb2Request | null, method: string) {
        const result = await this.proxy.send(body, path, method)
        const attestedResult = this.proxy.attest(result)
        return attestedResult
    }

    /**
     * Stop talking with the target.
     */
    stopTalking() {
        this.proxy.stop()
    }
}

class Proxy {
    /**
     * The proxy server used to forward HTTP requests.
     * @type {httpProxy}
     */
    private proxyServer: httpProxy
    private target: string
     /**
     * The web2 request.
     * @type {IWeb2Request}
     */
     private web2Request: IWeb2Request = null

    constructor(source: string, target: string) {
        this.target = target
        this.proxyServer = httpProxy.createProxyServer({target: this.target})

        https.createServer((req, res) => {
            this.proxyServer.web(req, res)
        }).listen(source)
    }

     /**
     * Send a request.
     * @param {IRawWeb2Request} payload - The payload.
     * @param {string} path - The path.
     * @param {string} method - The HTTP method that the proxy should call.
     * @returns {Promise<any>} The HTTP response.
     */
    send(payload: IRawWeb2Request = null, path: string, method: string = "GET") {
        // TODO Will need to take into consideration the case where the method is "GET" on the first hop.
        if (!payload && !(method === "GET")) {
            term.yellow.bold(
                "[Web2API] No raw request attached. Is this right?",
            )
            // TODO Specify this as a parameter that users can set
            this.web2Request.raw.minAttestations = 10
            this.web2Request.raw.stage.hopNumber = 0
        } else {
            this.web2Request.raw = payload
        }

        return new Promise((resolve, reject) => {
            const options = {
                hostname: this.target,
                port: 80,
                path: path,
                method: method,
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(JSON.stringify(payload)),
                },
            }

            const req = https.request(options, (res) => {
                res.setEncoding("utf8")
                let rawData = ""
                res.on("data", (chunk) => { rawData += chunk })
                res.on("end", () => {
                    resolve(JSON.parse(rawData))
                })
            })

            req.on("error", (error) => {
                reject(error)
            })

            if (method === "POST" || method === "PUT" || method === "PATCH") {
                req.write(JSON.stringify(payload))
            }

            req.end()
        })
    }

    /**
     * Stop the proxy server.
     */
    stop() {
        console.log("Stopping proxy server with target " + this.target)
        this.proxyServer.close()
    }

    /**
     * Attest the result.
     * @param {any} result - The HTTP result to attest.
     * @returns {any} The attestation.
     */
    attest(result: any) {
        const attestation = this.getAttestation(result)
        this.web2Request.raw.stage.hopNumber += 1 
        return attestation
    }

    /**
     * Validate the result.
     * @param {IWeb2Result} result - The result to validate.
     * @returns {Promise<IWeb2Attestation>} Returns an attestation.
     */
    async getAttestation(result: IWeb2Result): Promise<IWeb2Attestation> {
        term.yellow.bold("[Web2Parser] Validating...\n")
        const stringedResult = JSON.stringify(result)

        // Hashing and signing the result
        const hashedResult = Hashing.sha256(stringedResult)
        this.web2Request.hash = hashedResult
        term.bold("[Web2Parser] Result:\n")
        console.log(hashedResult)
        const signature = Cryptography.sign(
            hashedResult,
            sharedState.getInstance().identity.ed25519.privateKey,
        )
        this.web2Request.signature = signature
 
        // Composing our attestation
        const attestation: IWeb2Attestation = {
            hash: hashedResult,
            timestamp: Date.now(),
            identity: sharedState.getInstance().identity.ed25519.publicKey,
            signature: signature,
            valid: null,
        }
        term.bold("[Web2Parser] Attestation:\n")
        console.log(attestation)
        // Adding the attestation to the web2Request
        const hexKey = sharedState
            .getInstance()
            .identity.ed25519.publicKey.toString("hex") // REVIEW Is this ok?
        this.web2Request.attestations[hexKey] = attestation
        term.bold("[Web2Parser] Added attestation to web2Request\n")
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
        if (this.web2Request.result === undefined) {
            this.web2Request.result = result
        }
  
        return attestation
    }

    /**
     * Verify the web2Request based on the attestations. Checking attestations (one by one) and returning the result of the verification
     * @returns {Promise<boolean>} Whether the request is valid.
     */
    async verify(): Promise<boolean> {
        required(this.web2Request, "Missing request")
        let valid = true
        // Cycling through all the attestations
        for (const key of Object.keys(this.web2Request.attestations)) {
            const attestation = this.web2Request.attestations[key]
            // REVIEW Checking the hash validity for all the attestations
            const stringifiedContent = JSON.stringify(this.web2Request.raw)
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
            this.web2Request.attestations[key] = attestation
        }

        return valid
    }

    /**
     * Broadcast the request to another peer.
     */
    async next(): Promise<void> {
        required(this.web2Request, "Missing request")
        // Selecting a random peer (just one)
        const peerList = PeerManager.getInstance().getPeers()
        const peer = peerList[Math.floor(Math.random() * peerList.length)]
        // Forwarding the request to the selected peer

        // TODO Send the request to the next peer
    }
    
    /**
     * @returns {number} The number of attestations.
     */
    getNumberOfAttestations(): number {
        return Object.keys(this.web2Request.attestations).length
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
            if (this.getNumberOfAttestations() >= quorum) {
                reachedQuorum = true
                break
            }
            timer += 100
        }
        return reachedQuorum
    }
}