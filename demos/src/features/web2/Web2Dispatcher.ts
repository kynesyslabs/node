// INFO Entry file for handling web2 requests
import { IWeb2Request, IWeb2Payload } from "./routine/Web2Parser"
import Web2API from "./routine/Web2Parser"
import { Operation } from "src/libs/blockchain/routines/executeOperations"
import required from "src/utilities/required"
import Cryptography from "src/libs/crypto/cryptography"
import sharedState from "src/utilities/sharedState"
import Hashing from "src/libs/crypto/hashing"
import { deriveMempoolOperation } from "src/libs/utils/demos_stdlib"

// INFO Upon receiving a request from a socket, we
// need to attest and handle the other attestations (if we 
// are either first or not last of the chain), and then
// send back to the client or to the origin rpc the
// transaction that will be granted as web2 result
export default async function handleWeb2(payload: IWeb2Payload, senderSocket: any): Promise<[boolean, any]> {
    // Creating the workable interface
    // TODO Remember that web2 could need to be signed and could need a fee
    // NOTE From now on, Web2API will reply to instanceName with the same instance
    // NOTE Also note that Web2API automatically starts the request validation

    console.log("[PAYLOAD FOR WEB2] ")
    console.log(payload)
    let request: IWeb2Request = payload.message.content
    console.log("[REQUEST FOR WEB2] ")
    console.log(request)
    //process.exit(0)

    let web2request = Web2API(null, senderSocket, payload) // NOTE null is important here
    let instanceName = web2request.name // Numeric and progressive
    // Checking if we are the original rpc that received the request
    let nOfAttestations = request.attestations.size
    let originalFlag = (nOfAttestations === 1) // Remember: we attested during the initialization
    // ANCHOR Original RPC logic
    // NOTE If we are the original rpc and this is the original request, we need to validate the request
    // and wait for the attestations to arrive
    if (originalFlag) {
        try {
            // Ensuring we reach the quorum if we are the original rpc that received the request
            required(await Web2API(instanceName).awaitQuorum(), "Not enough attestations to reach quorum")
            // Hashing and signing the request
            let hashedAttestations = Hashing.sha256(JSON.stringify(web2request.request.message.content.attestations))
            let ourPk = sharedState.getInstance().identity.ed25519.privateKey
            let signedAttestations = Cryptography.sign(hashedAttestations, ourPk)
            // Compiling and certifying the result
            web2request.request.message.content.hash = hashedAttestations
            web2request.request.message.content.signature = signedAttestations
            // REVIEW And then we can send the response back to the client
            return [true, web2request.request]
        } catch (error) {
            return [false, error]
        }
    }
    // ANCHOR Subsequent handling of the attestations
    // NOTE If we are not the original rpc that received the request, or if the request's attestations are
    // coming back from the various peers, then we need to handle the attestations
    else {
        // First, we have to validate the attestations
        web2request.verify()
        // Now that our web2request.request object is updated,
        // TODO we have to merge the attestations' arrays with valid values
    }
    let derivedTx = await toMempool(instanceName)
    // Sending back the result
    // REVIEW Maybe is more efficient somewhere else
    return [true, derivedTx]
}

// INFO Derive a valid DEMOS tx and GLS operation from a web2 request
async function toMempool(
    instanceName: string,
    insert: boolean = true,
) {
    // We should have a valid, attested request: lets handle it
    let derivedOperation: Operation
    // NOTE If all the attestations are valid we can create the transaction, insert it and gibe back the result
    // Deriving an operation and a tx from the web2 request
    derivedOperation = await deriveMempoolOperation(
        Web2API(instanceName).request,
        insert)
    return derivedOperation
}
