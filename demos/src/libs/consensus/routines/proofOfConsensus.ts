import sharedState from "src/utilities/sharedState"
import Cryptography from "src/libs/crypto/cryptography"
import { demostdlib } from "src/libs/utils"
import { Peer } from "src/libs/peer"

export async function proofConsensus(hash: string): Promise<[string, string]> {
    let poc: [string, string] = [hash, null]
    // Obtain Paperinik (PK, Public Key) and Public hash
    const pk = sharedState.getInstance().identity.ed25519.privateKey

    // Signing the hash
    const signature = Cryptography.sign(hash, pk)

    console.log("signature")
    console.log(signature.toString("hex"))

    const signatureHex = signature.toString("hex")
    // Adding the signature to the PoC
    poc[1] = signatureHex
    // Returning the PoC
    return poc
}

export async function proofConsensusHandler(raw_content: any): Promise<any> {
    let require_reply = true // REVIEW Sure?
    let extra: string, response: [string, string]
    let content = JSON.parse(raw_content.message)
    // REVIEW Check if the content is valid - Or maybe not
    response = await proofConsensus(content.hash)
    return { extra, response, require_reply }
}

export async function askPoC(hash: string, peer: Peer): Promise<any> {
    let content = JSON.stringify({ hash: hash, poc: null })
    let response = await demostdlib.remoteCall(
        "any",
        peer,
        content,
        "proofOfConsensus",
        true,
        false,
    )
    if (response[0]) {
        return response[1]
    } else {
        return null
    }
}
