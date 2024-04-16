// INFO Entry file for handling web2 requests
import Web2API, { Web2APIClass } from "src/features/web2/routines/Web2Parser"
import { IWeb2Payload, IWeb2Request } from "@kynesyslabs/demosdk/types"
import { Operation } from "@kynesyslabs/demosdk/types"
import Cryptography from "src/libs/crypto/cryptography"
import Hashing from "src/libs/crypto/hashing"
import {
    DerivableNative,
    deriveMempoolOperation,
} from "src/libs/utils/demostdlib/deriveMempoolOperation"
import required from "src/utilities/required"
import sharedState from "src/utilities/sharedState"
// NOTE Terminal kit for useful logging
import terminalkit from "terminal-kit"

const term = terminalkit.terminal

// INFO Upon receiving a request from a socket, we
// need to attest and handle the other attestations (if we
// are either first or not last of the chain), and then
// send back to the client or to the origin rpc the
// transaction that will b  e granted as web2 result
export default async function handleWeb2(
    payload: IWeb2Request,
    senderSocket: any,
): Promise<[boolean, string | IWeb2Request]> {
    // Creating the workable interface
    // TODO Remember that web2 could need to be signed and could need a fee
    // NOTE From now on, Web2API will reply to instanceName with the same instance
    // NOTE Also note that Web2API automatically starts the request validation

    console.log("[PAYLOAD FOR WEB2] [*] Received a Web2 Payload.")
    console.log("[PAYLOAD FOR WEB2] [*] Beginning sanitization checks...")
    //console.log(payload)
    //process.exit(0)

    let request: IWeb2Request = payload
    console.log(
        "[REQUEST FOR WEB2] [+] Found and loaded payload.message as expected...",
    )
    //console.log(request)
    //process.exit(0)

    // TODO A little more of sanitiazion

    let uuid = JSON.stringify(payload)
    uuid = uuid + Date.now().toString()
    let nameHash = Hashing.sha256(uuid)

    // NOTE Web2API instantiates and creates a proper Web2APIClass with its methods and a clean state
    /*
     * As it can be noted by following the class definition, the Web2API class works as a unique set of
     * singletons. In Web2API constructor, the .digestedPromise propriety contains a promise from the
     * .digest() method which is resolved once the attestation path (the Instant Chain of Trust) is completed
     * or the request times out.
     *
     * An attestation is automatically added by the .digest() method, attesting its result
     * TODO Implement timeouts properly
     */
    let web2interface = Web2API(null, nameHash, senderSocket, payload)
    // NOTE We want to wait for the request to be digested before proceeding (see above paragraph)
    await web2interface.digestedPromise
    // Now result is in web2request.request.result
    console.log(
        "[web2Dispatcher] Request digested and promise solved. Registering the instance...",
    )
    let instanceName = web2interface.name // Numeric and progressive
    // Checking if we are the original rpc that received the request
    /* NOTE The attestations are enforced by being part of the payload itself,
     * hence being verified by the signature of the payload itself.
     * This way, the agnostic chain of trust can be maintained with minimal overhead.
     */
    let nOfAttestations = Object.keys(request.attestations).length
    let originalFlag = nOfAttestations === 1 // REVIEW Remember: we attested during the initialization
    console.log("[web2Dispatcher] Number of attestations: " + nOfAttestations)
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
                    await Web2API(null, instanceName).awaitQuorum(),
                    "Not enough attestations to reach quorum",
                ) // SWITCH
            }
            term.green("[web2Dispatcher] [+] Quorum reached!")
            // Hashing and signing the request
            term.green(
                "[web2Dispatcher] [*] Hashing and signing the request's attestations...",
            )
            let hashedAttestations = Hashing.sha256(
                JSON.stringify(web2interface.request.attestations),
            )
            let ourPk = sharedState.getInstance().identity.ed25519.privateKey
            let signedAttestations = Cryptography.sign(
                hashedAttestations,
                ourPk,
            )
            // Compiling and certifying the result
            term.green(
                "[web2Dispatcher] [*] Compiling and certifying the result on our side...",
            )
            web2interface.request.hash = hashedAttestations
            web2interface.request.signature = signedAttestations
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
    // REVIEW Should we return this too?
    let derivedResult = await toMempool(instanceName)
    console.log("[web2Dispatcher] Transaction + operation derived.")

    Web2API("remove", nameHash, senderSocket)

    //console.log(derivedTx)
    // Sending back the result
    // REVIEW Maybe is more efficient somewhere else
    //console.log("[WEB2 DEBUG]")
    // console.log(JSON.stringify(web2interface.request))

    // TODO Maybe we should also return derivedResult somehow
    return [true, web2interface.request] // , derivedResult
}

// INFO Derive a valid DEMOS tx and GLS operation from a compatible request
async function toMempool(
    instanceName: string,
    insert: boolean = true,
): Promise<[string, Operation]> {
    // We should have a valid, attested request: lets handle it
    let derivedResults: [string, Operation]
    let web2Instance: Web2APIClass = Web2API(null, instanceName)
    let derivable: DerivableNative = {
        from: "web2module", // FIXME Implement this
        to: "web2", // FIXME Implement this more in details
        type: "web2",
        data: web2Instance.request,
        timestamp: Date.now(),
        fees: {
            networkFee: 0,
            rpcFee: 0,
            additionalFee: 0,
        }, // FIXME Implement this
    }
    // NOTE If all the attestations are valid we can create the transaction, insert it and give back the result
    // Deriving an operation and a tx from the web2 request
    derivedResults = await deriveMempoolOperation(derivable, insert)
    return derivedResults
}
