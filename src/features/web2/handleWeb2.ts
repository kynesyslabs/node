// INFO Entry file for handling web2 requests
import Cryptography from "src/libs/crypto/cryptography"
import Hashing from "src/libs/crypto/hashing"
import required from "src/utilities/required"
import sharedState from "src/utilities/sharedState"

import {
    IWeb2Request,
  } from "@kynesyslabs/demosdk/types"

import { Web2RequestManager } from "./Web2RequestManager"
import { DAHRManager } from "src/features/web2/dahr/DAHRManager"

import terminalKit from "terminal-kit"
import { DAHR } from "./dahr/DAHR"

const term = terminalKit.terminal

/**
 * Handles a Web2 request.
 *
 * This function receives a request from a socket, attests and handles other attestations,
 * and then sends back to the client or to the origin rpc a DAHR instance promise.
 *
 * @param {IWeb2Request} payload - The Web2 request to handle.
 *
 * @returns {Promise<[boolean, string | DAHR]>} - Returns a promise that resolves to a tuple. The first element of the tuple is a boolean indicating whether the operation was successful. The second element is either a string containing an error message, or a DAHR instance.
 *
 * @throws Will throw an error if the operation fails.
 */
export async function handleWeb2(
    payload: IWeb2Request,
): Promise<[boolean, string | DAHR]> {
    // TODO Remember that web2 could need to be signed and could need a fee
    console.log("[PAYLOAD FOR WEB2] [*] Received a Web2 Payload.")
    console.log("[PAYLOAD FOR WEB2] [*] Beginning sanitization checks...")

    const request: IWeb2Request = payload
    console.log(
        "[REQUEST FOR WEB2] [+] Found and loaded payload.message as expected...",
    )

    // TODO A little more of sanitization checks
    let uuid = JSON.stringify(payload)
    uuid = uuid + Date.now().toString()
    const nameHash = Hashing.sha256(uuid)

    // TODO Implement timeouts properly
    const DAHRManagerInstance = DAHRManager.instance
    const DAHR = DAHRManagerInstance.getDAHR(nameHash)
    const web2RequestManager = new Web2RequestManager(DAHR)

    console.log(
        "[handleWeb2] DAHR instance created.",
    )

    const numOfAttestations = Object.keys(request.attestations).length
    const originalFlag = numOfAttestations === 1
    console.log("[handleWeb2] Number of attestations: " + numOfAttestations)

    /**
     * Original RPC logic
     *
     * If we are the original rpc and this is the original request, we need to validate the request and wait for the attestations to arrive
     *
     */
    if (originalFlag) {
        console.log(
            "[handleWeb2] This is the original rpc. We will wait for attestations.",
        )
        try {
            term.yellow(
                "[handleWeb2] [*] Waiting for the required quorum for this chain of trust...",
            )

            /* FIXME DEVEL Activate in production */
            if (sharedState.getInstance().PROD) {
                required(
                    await web2RequestManager.quorumIsReached(),
                    "Not enough attestations to reach quorum",
                )
            }

            term.green("[handleWeb2] [+] Quorum reached!")
            term.green(
                "[handleWeb2] [*] Hashing and signing the request's attestations...",
            )

            const hashedAttestations = Hashing.sha256(JSON.stringify(DAHR.web2Request.attestations))
            const ourPrivateKey = sharedState.getInstance().identity.ed25519.privateKey
            const signedAttestations = Cryptography.sign(
                hashedAttestations,
                ourPrivateKey,
            )
    
            term.green(
                "[handleWeb2] [*] Compiling and certifying the result on our side...",
            )

            DAHR.web2Request.hash = hashedAttestations
            DAHR.web2Request.signature = signedAttestations
        } catch (error) {
            console.log("[handleWeb2] Error: " + JSON.stringify(error))
            return [false, JSON.stringify(error)]
        }
    }

    else {
        /* TODO Activate the below on production  */
        // First, we have to validate the attestations
        // web2RequestManager.web2ResultIsValid
        // Now that our web2request.request object is updated,
        // TODO we have to merge the attestations' arrays with valid values
    }

    console.log(
        "[handleWeb2] Done! Sending the response back to the client...",
    )
    console.log(
        "[handleWeb2] Attestations validated. Deriving a transaction + operation...",
    )

    return [true, DAHR]
}
