import Cryptography from "src/libs/crypto/cryptography"
import { RPCResponse } from "@kynesyslabs/demosdk/types"
import { Peer } from "src/libs/peer"
import { demostdlib } from "src/libs/utils"
import { getSharedState } from "src/utilities/sharedState"
import log from "src/utilities/logger"

export async function proofConsensus(hash: string): Promise<[string, string]> {
    const poc: [string, string] = [hash, null]
    // Obtain Paperinik (PK, Public Key) and Public hash
    const pk = getSharedState.identity.ed25519.privateKey
    const publicHex = getSharedState
        .identity.ed25519.publicKey.toString("hex")
    // Signing the hash

    log.debug(`[POC] proofConsensus - publicHex: ${publicHex}, hash: ${hash}`)

    const signature = Cryptography.sign(hash, pk)

    log.debug(`[POC] proofConsensus - signature: ${signature.toString("hex")}`)

    const signatureHex = signature.toString("hex")
    // Adding the signature to the PoC
    poc[1] = signatureHex
    // Returning the PoC
    return poc
}

export async function proofConsensusHandler(hash: any): Promise<RPCResponse> {
    const response: RPCResponse = {
        result: 200,
        response: "",
        require_reply: true,
        extra: "",
    }
    //console.log(raw_content)
    // process.exit(0)
    // REVIEW Check if the content is valid - Or maybe not
    log.debug("[POC] proofConsensusHandler - handling hash")
    //console.log(content)
    const pocFullResponse = await proofConsensus(hash)
    response.response = pocFullResponse[0]
    response.extra = pocFullResponse[1]
    return response
}

export async function askPoC(hash: string, peer: Peer): Promise<any> {
    const pocCall = {
        method: "proofOfConsensus",
        params: [hash],
    }
    log.debug("[POC] Asking for PoC")
    const response = await peer.call(pocCall)
    if (response.result === 200) {
        return response.response
    } else {
        return null
    }
}
