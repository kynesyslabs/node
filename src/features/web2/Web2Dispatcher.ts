// INFO Entry file for handling web2 requests
import { DAHRManager } from "src/features/web2/dahr/DAHRManager"
import Cryptography from "src/libs/crypto/cryptography"
import Hashing from "src/libs/crypto/hashing"
import required from "src/utilities/required"
import sharedState from "src/utilities/sharedState"
import terminalKit from "terminal-kit"

import { IWeb2Request } from "@kynesyslabs/demosdk/types"
import { Web2RequestManager } from "./Web2RequestManager"

const term = terminalKit.terminal

/**
 * Handles a Web2 request.
 *
 * This function receives a request from a socket, attests and handles other attestations,
 * and then sends back to the client or to the origin rpc the transaction that will be granted as web2 result.
 *
 * @param {IWeb2Request} payload - The Web2 request to handle.
 * @param {any} senderSocket - The socket that sent the request.
 *
 * @returns {Promise<[boolean, string | IWeb2Request]>} - Returns a promise that resolves to a tuple.
 * The first element of the tuple is a boolean indicating whether the operation was successful.
 * The second element is either a string containing an error message, or the processed Web2 request.
 *
 * @throws Will throw an error if the operation fails.
 */
export default async function handleWeb2(
    payload: IWeb2Request,
    senderSocket: any,
): Promise<[boolean, string | IWeb2Request]> {
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
    // Creating the interface
    const DAHRManagerInstance = DAHRManager.instance
    const DAHR = DAHRManagerInstance.getDAHR(nameHash, payload)

    console.log(
        "[web2Dispatcher] dahr instance created.",
    )
    const DAHRInstanceName = nameHash // Numeric and progressive
    // Checking if we are the original rpc that received the request
    /* NOTE The attestations are enforced by being part of the payload itself,
     * hence being verified by the signature of the payload itself.
     * This way, the agnostic chain of trust can be maintained with minimal overhead.
     */
    const numOfAttestations = Object.keys(request.attestations).length
    const originalFlag = numOfAttestations === 1 // REVIEW Remember: we attested during the initialization
    console.log("[web2Dispatcher] Number of attestations: " + numOfAttestations)
    // ANCHOR Original RPC logic
    // NOTE If we are the original rpc and this is the original request, we need to validate the request
    // and wait for the attestations to arrive
    if (originalFlag) {
        console.log(
            "[web2Dispatcher] This is the original rpc. We will wait for attestations.",
        )
        try {
            /* FIXME DEVEL Activate in production */
            // Ensuring we reach the quorum if we are the original rpc that received the request
            term.yellow(
                "[web2Dispatcher] [*] Waiting for the required quorum for this chain of trust...",
            )
            if (sharedState.getInstance().PROD) {
                required(
                    await new Web2RequestManager(DAHR).quorumIsReached(),
                    "Not enough attestations to reach quorum",
                ) // SWITCH
            }
            term.green("[web2Dispatcher] [+] Quorum reached!")
            // Hashing and signing the request
            term.green(
                "[web2Dispatcher] [*] Hashing and signing the request's attestations...",
            )
            const hashedAttestations = Hashing.sha256(
                JSON.stringify(DAHR.web2Request.attestations),
            )
            const ourPk = sharedState.getInstance().identity.ed25519.privateKey
            const signedAttestations = Cryptography.sign(
                hashedAttestations,
                ourPk,
            )
            // Compiling and certifying the result
            term.green(
                "[web2Dispatcher] [*] Compiling and certifying the result on our side...",
            )
            DAHR.web2Request.hash = hashedAttestations
            DAHR.web2Request.signature = signedAttestations
        } catch (error) {
            // Catching errors before the return
            console.log("[web2Dispatcher] Error: " + JSON.stringify(error))
            return [false, JSON.stringify(error)]
        }
    }
    // ANCHOR Subsequent handling of the attestations
    // NOTE If we are not the original rpc that received the request, or if the request's attestations are
    // coming back from the various peers, then we need to handle the attestations
    else {
        /* TODO Activate the below on production  */
        // First, we have to validate the attestations
        // web2interface.verify()
        // Now that our web2request.request object is updated,
        // TODO we have to merge the attestations' arrays with valid values
    }
    // NOTE If we are here, we somehow have something to return
    // REVIEW And then we can send the response back to the client
    console.log(
        "[web2Dispatcher] Done! Sending the response back to the client...",
    )
    console.log(
        "[web2Dispatcher] Attestations validated. Deriving a transaction + operation...",
    )

    // TODO Figure out what to return here. We want to return a DAHR instance and let the client handle the rest
    /* return [true, dahr.initializeDAHR] */
}
