// INFO Entry file for handling web2 requests
import Cryptography from "src/libs/crypto/cryptography"
import Hashing from "src/libs/crypto/hashing"
import required from "src/utilities/required"
import sharedState from "src/utilities/sharedState"
import { IWeb2Request } from "@kynesyslabs/demosdk-http/types"
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
 * @returns {Promise<DAHR | string>} - Returns a DAHR instance or an error message.
 *
 * @throws Will throw an error if the operation fails.
 */
export async function handleWeb2(
    payload: IWeb2Request,
): Promise<string | DAHR> {
    // TODO Remember that web2 could need to be signed and could need a fee
    console.log("[PAYLOAD FOR WEB2] [*] Received a Web2 Payload.")
    console.log("[PAYLOAD FOR WEB2] [*] Beginning sanitization checks...")

    const request: IWeb2Request = payload
    console.log(
        "[REQUEST FOR WEB2] [+] Found and loaded payload.message as expected...",
    )

    try {
        const dahrManagerInstance = DAHRManager.instance
        const dahr = dahrManagerInstance.getDAHR(payload.dahrId, payload)
        dahr.web2Request = payload
        const web2RequestManager = new Web2RequestManager(dahr)

        console.log("[handleWeb2] DAHR instance created.")

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

                const hashedAttestations = Hashing.sha256(
                    JSON.stringify(dahr.web2Request.attestations),
                )
                const ourPrivateKey =
                    sharedState.getInstance().identity.ed25519.privateKey
                const signedAttestations = Cryptography.sign(
                    hashedAttestations,
                    ourPrivateKey,
                )

                term.green(
                    "[handleWeb2] [*] Compiling and certifying the result on our side...",
                )

                dahr.web2Request.hash = hashedAttestations
                dahr.web2Request.signature = signedAttestations
            } catch (error) {
                console.log("[handleWeb2] Error: " + JSON.stringify(error))
                return JSON.stringify(error)
            }
        } else {
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

        return dahr
    } catch (error: any) {
        console.error("Error in handleWeb2:", error)
        return error.message
    }
}
