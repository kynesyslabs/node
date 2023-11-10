import sharedState from "src/utilities/sharedState"
import Cryptography from "src/libs/crypto/cryptography"

export interface IPOC {
	hash: string
	shard: Map <string, string>
}

export async function proofConsensus(hash: string, poc: IPOC = null): Promise<IPOC> {
	// Creating a PoC if not provided
	if (!poc) {
		poc = {
			hash: hash,
			shard: new Map(),
		}
	}
	// Obtain Paperinik and Public hash
	const pk = sharedState.getInstance().identity.ed25519.privateKey
	const publicHex = sharedState.getInstance().identity.ed25519.publicKey.toString("hex")
	// Signing the hash
	const signature = Cryptography.sign(hash, pk)
	const signatureHex = signature.toString("hex")
	// Adding the signature to the PoC
	poc.shard.set(publicHex, signatureHex)
	// Returning the PoC
	return poc
}