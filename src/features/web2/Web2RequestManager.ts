import Cryptography from "src/libs/crypto/cryptography"
import Hashing from "src/libs/crypto/hashing"
import { PeerManager } from "src/libs/peer"
import required from "src/utilities/required"
import sharedState from "src/utilities/sharedState"

import {
    IWeb2Attestation,
    IWeb2Request,
    IWeb2Result,
} from "@kynesyslabs/demosdk/types"
import { DAHR } from "./dahr/DAHR"

import terminalKit from "terminal-kit"

const term = terminalKit.terminal

export class Web2RequestManager {
    constructor(private dahr: DAHR) {
        required(this.dahr, "Missing DAHR instance")
    }

    get web2ResultIsValid(): boolean {
        return this._verifyWeb2RequestAndResult()
    }

    get numberOfAttestations(): number {
        return Object.keys(this.dahr.web2Request.attestations).length
    }

    /**
     * Retrieves an attested result for a Web2 request.
     *
     * This method validates the Web2 request and its result, creates a combined attestation,
     * increments the hop number, and returns the attestation.
     *
     * @param {IWeb2Result} web2Result - The result of the Web2 request to be attested.
     * @returns {IWeb2Attestation} The combined attestation for the Web2 request and result.
     */
    getAttestedResult(web2Result: IWeb2Result): IWeb2Attestation {
        const combinedAttestation = this._validateWeb2RequestAndResult(
            this.dahr.web2Request,
            web2Result,
        )

        this.dahr.web2Request.raw.stage.hop_number += 1

        term.bold("[Web2Parser] Combined Attestation:\n")
        console.log(combinedAttestation)

        return combinedAttestation
    }

    /**
     * Validate the web2 request and result.
     * @param {IWeb2Request} web2Request - The web2 request to validate.
     * @param {IWeb2Result} web2Result - The web2 result to validate.
     * @returns {IWeb2Attestation} The web2 attestation.
     */
    private _validateWeb2RequestAndResult(
        web2Request: IWeb2Request,
        web2Result: IWeb2Result,
    ): IWeb2Attestation {
        term.yellow.bold("[Web2Parser] Validating request and result...\n")

        // Combine request and result into a single object
        const combinedData = {
            request: web2Request.raw,
            result: web2Result,
        }

        const stringedCombined = JSON.stringify(combinedData)
        const hashedCombined = Hashing.sha256(stringedCombined)

        term.bold("[Web2Parser] Combined hash:\n")
        console.log(hashedCombined)

        const signature = Cryptography.sign(
            hashedCombined,
            sharedState.getInstance().identity.ed25519.privateKey,
        )

        const attestation: IWeb2Attestation = {
            hash: hashedCombined,
            timestamp: Date.now(),
            identity: sharedState.getInstance().identity.ed25519.publicKey,
            signature: signature,
            valid: null,
        }
        term.bold("[Web2Parser] Combined Attestation:\n")
        console.log(attestation)

        const hexKey = sharedState
            .getInstance()
            .identity.ed25519.publicKey.toString("hex")

        // Store the attestation in the web2Request
        web2Request.attestations[hexKey] = attestation

        // Update the hash and signature of the web2Request
        web2Request.hash = hashedCombined
        web2Request.signature = signature

        // Store the result in the web2Request if it's not already set
        if (web2Request.result === undefined) {
            web2Request.result = web2Result
        }

        term.bold("[Web2Parser] Added combined attestation to web2Request\n")

        return attestation
    }

    /**
     * Verify the web2Request and result based on the attestations. Checking attestations (one by one) and returning the result of the verification.
     * @returns {boolean} Whether the result is valid.
     */
    private _verifyWeb2RequestAndResult(): boolean {
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
    async quorumIsReached(
        quorum: number = 10,
        timeout: number = 9000,
    ): Promise<boolean> {
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
