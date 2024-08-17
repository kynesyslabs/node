import Cryptography from "src/libs/crypto/cryptography"
import { RPCResponse } from "src/libs/network/server_rpc"
import { Peer } from "src/libs/peer"
import { demostdlib } from "src/libs/utils"
import sharedState from "src/utilities/sharedState"

export async function proofConsensus(hash: string): Promise<[string, string]> {
    let poc: [string, string] = [hash, null]
    // Obtain Paperinik (PK, Public Key) and Public hash
    const pk = sharedState.getInstance().identity.ed25519.privateKey
    const publicHex = sharedState
        .getInstance()
        .identity.ed25519.publicKey.toString("hex")
    // Signing the hash

    console.log("publicHex")
    console.log(publicHex)

    console.log("WATMA")
    console.log("pk: " + pk)
    console.log(hash)

    const signature = Cryptography.sign(hash, pk)

    console.log("signature")
    console.log(signature.toString("hex"))

    const signatureHex = signature.toString("hex")
    // Adding the signature to the PoC
    poc[1] = signatureHex
    // Returning the PoC
    return poc
}

export async function proofConsensusHandler(hash: any): Promise<RPCResponse> {
    let response: RPCResponse = {
        result: 200,
        response: "",
        require_reply: true,
        extra: "",
    }
    //console.log(raw_content)
    // process.exit(0)
    // REVIEW Check if the content is valid - Or maybe not
    console.log("proofConsensusHandler")
    //console.log(content)
    let pocFullResponse = await proofConsensus(hash)
    response.response = pocFullResponse[0]
    response.extra = pocFullResponse[1]
    return response
}

export async function askPoC(hash: string, peer: Peer): Promise<any> {
    let poc_call = {
        method: "proofOfConsensus",
        params: [hash],
    }
    /*let response = await demostdlib.remoteCall(
        "any",
        peer,
        hash,
        "proofOfConsensus",
        true,
        false,
    ) */
    /* FIXME  // ! This is not working. Log: 
    Deriving block...
    [INFO] [2024-08-16T14:13:47.699Z] [RPC Call] Response:
    [INFO] [2024-08-16T14:13:47.699Z] {
    "result": 200,
    "response": "8edb031430335b13aaecad695ef1ac6234342222d408c3feb06fb4c49dcc3b57",
    "require_reply": false,
    "extra": null
    }
    [INFO] [2024-08-16T14:13:47.699Z] [RPC Call] [Response] Response OK: 8edb031430335b13aaecad695ef1ac6234342222d408c3feb06fb4c49dcc3b57
    Voting will compare:

    e795515415848c7058ba19c9fa9de372b42d7e760bebea704cc1250e529774d2
    [sQBFT Voting]
    Parameter: forgedProposedHash
    Our value: e795515415848c7058ba19c9fa9de372b42d7e760bebea704cc1250e529774d2
    Ok: 0 | Invalid: 1

    [BFT] Checking consensus. Got 0 pro and 1 against votes}, got 1 votes
    [sQBFT] We don't have a theoric consensus!
    */
    let response = await peer.call(poc_call)
    if (response.result===200) {
        return response.response
    } else {
        return null
    }
}
