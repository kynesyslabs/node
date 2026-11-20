import { Demos } from "@kynesyslabs/demosdk/websdk"
import { ucrypto, Hashing, uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"

/**
 * A fresh node identity: the mnemonic and the ed25519 address a node that
 * loads it signs with. The seed mirrors src/libs/identity/identity.ts
 * (sha3_512 over the raw mnemonic, its hex string as the seed); a bip39
 * seed would give another key than the node's.
 */
export async function newDemosIdentity(): Promise<{ mnemonic: string; address: string }> {
    const mnemonic = new Demos().newMnemonic()
    const seedHashHex = uint8ArrayToHex(Hashing.sha3_512(mnemonic)).slice(2)
    await ucrypto.generateAllIdentities(new TextEncoder().encode(seedHashHex))
    const identity = await ucrypto.getIdentity("ed25519")
    return { mnemonic, address: "0x" + identity.publicKey.toString("hex") }
}
