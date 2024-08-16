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
    // FIXME If peer has no socket, it will crash (shouldn't exist btw)
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
    let response = await peer.call(poc_call)
    if (response.result===200) {
        return response.result
    } else {
        return null
    }
}
