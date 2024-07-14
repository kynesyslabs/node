import Cryptography from "src/libs/crypto/cryptography"
import Hashing from "src/libs/crypto/hashing"
import { PeerManager } from "src/libs/peer"
import required from "src/utilities/required"
import sharedState from "src/utilities/sharedState"

import {
  IWeb2Attestation,
} from "@kynesyslabs/demosdk/types"

import { DAHR } from "./dahr/DAHR"

import terminalKit from "terminal-kit"

const term = terminalKit.terminal

export class Web2RequestManager {
    constructor(private dahr: DAHR) {
        required(this.dahr, "Missing DAHR instance")
    }

    get web2PromiseIsValid(): Promise<boolean> {
        return this.verifyWeb2Promise()
    }

    get numberOfAttestations(): number {
        return Object.keys(this.dahr.web2Request.attestations).length
    }

    /**
     * Increase hopNumber by one and return the web2 attestation promise.
     * @param {Promise<any>} web2Promise - The HTTP promise to validate.
     * @returns {Promise<IWeb2Attestation>} The web2 attestation promise.
     */
    async getAttestedResult(web2Promise: Promise<any>): Promise<IWeb2Attestation> {
        const attestedResult = this.validateWeb2Promise(web2Promise)
        this.dahr.web2Request.raw.stage.hopNumber += 1 
        return attestedResult
    }

    /**
     * Validate the web2 result.
     * @param {Promise<any>} web2Promise - The HTTP promise to validate.
     * @returns {Promise<IWeb2Attestation>} The web2 attestation promise.
     */
    private async validateWeb2Promise(web2Promise: Promise<any>): Promise<IWeb2Attestation> {
        term.yellow.bold("[Web2Parser] Validating...\n")

        const web2Result = await web2Promise
        const stringedResult = JSON.stringify(await web2Promise)
        const hashedResult = Hashing.sha256(stringedResult)
        this.dahr.web2Request.hash = hashedResult
        term.bold("[Web2Parser] Result:\n")
        console.log(hashedResult)
        const signature = Cryptography.sign(
            hashedResult,
            sharedState.getInstance().identity.ed25519.privateKey,
        )
        this.dahr.web2Request.signature = signature

        const attestation: IWeb2Attestation = {
            hash: hashedResult,
            timestamp: Date.now(),
            identity: sharedState.getInstance().identity.ed25519.publicKey,
            signature: signature,
            valid: null,
            result: web2Result,
        }
        term.bold("[Web2Parser] Attestation:\n")
        console.log(attestation)

        const hexKey = sharedState
            .getInstance()
            .identity.ed25519.publicKey.toString("hex")
        this.dahr.web2Request.attestations[hexKey] = attestation
        term.bold("[Web2Parser] Added attestation to web2Request\n")

        if (this.dahr.web2Request.result === undefined) {
            this.dahr.web2Request.result = web2Result
        }

        return attestation
    }

    /**
     * Verify the web2Promise based on the attestations. Checking attestations (one by one) and returning the result of the verification.
     * @returns {Promise<boolean>} Whether the promise is valid.
     */
    private async verifyWeb2Promise(): Promise<boolean> {
        required(this.dahr.web2Request, "Missing request")
        let valid = true
        
        for (const key of Object.keys(this.dahr.web2Request.attestations)) {
            const attestation = this.dahr.web2Request.attestations[key]
            const stringifiedContent = JSON.stringify(this.dahr.web2Request.raw)
            const hash = Hashing.sha256(stringifiedContent)

            const hashIsValid = hash === attestation.hash
            const signatureIsValid = Cryptography.verify(
                attestation.signature.toString("hex"),
                attestation.hash,
                attestation.identity,
            )
            const isValid = hashIsValid && signatureIsValid
            attestation.valid = isValid

            if (!isValid) valid = false
            this.dahr.web2Request.attestations[key] = attestation
        }

        return valid
    }

    async broadcastToNextPeer(): Promise<void> {
        required(this.dahr.web2Request, "Missing request")
    
        const peerList = PeerManager.getInstance().getPeers()
        const peer = peerList[Math.floor(Math.random() * peerList.length)]
        // Forwarding the request to the selected peer

        // TODO Send the request to the next peer
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
    async quorumIsReached(quorum: number = 10, timeout: number = 9000): Promise<boolean> {
        let reachedQuorum = false
        let timer = 0
        // NOTE We wait for timeout seconds before surrendering
        while (timer < timeout) {
            await new Promise(resolve => setTimeout(resolve, 100)) // Each 100 ms we can check for updates
            if (this.numberOfAttestations >= quorum) {
                reachedQuorum = true
                break
            }
            timer += 100
        }
        return reachedQuorum
    }
}