import sharedState from "src/utilities/sharedState"
import Cryptography from "src/libs/crypto/cryptography"
import { demostdlib } from "src/libs/utils"
import { Peer } from "src/libs/peer"

export interface IPOC {
    hash: string
    shard: Map<string, string>
}

export async function proofConsensus(
    hash: string,
    poc: IPOC = null,
): Promise<IPOC> {
    // Creating a PoC if not provided
    if (!poc) {
        poc = {
            hash: hash,
            shard: new Map(),
        }
    }
    // Obtain Paperinik (PK, Public Key) and Public hash
    const pk = sharedState.getInstance().identity.ed25519.privateKey
    const publicHex = sharedState
        .getInstance()
        .identity.ed25519.publicKey.toString("hex")
    // Signing the hash
    const signature = Cryptography.sign(hash, pk)
    const signatureHex = signature.toString("hex")
    // Adding the signature to the PoC
    poc.shard.set(publicHex, signatureHex)
    // Returning the PoC
    return poc
}


export async function proofConsensusHandler(content: any): Promise<any> {
	let require_reply = true // REVIEW Sure?
	let extra: string, response: IPOC
	// TODO Check if the content is valid
	response = await proofConsensus(content.hash, content.poc)
	return { extra, response, require_reply }
}


export async function askPoC(hash: string, peer: Peer): Promise<any> {
    let response = await demostdlib.remoteCall(
        "any",
        peer,
        hash,
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
