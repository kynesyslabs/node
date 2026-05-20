/**
 * Derive the ed25519 pubkey from an existing mnemonic file using the
 * exact same path as src/libs/identity/identity.ts (sha3_512 of raw
 * mnemonic). Used to sanity-check that .test-identity/pubkey matches
 * what the running node will compute.
 */

import * as fs from "fs"
import { ucrypto, Hashing, uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"

const mnemonicFile = process.argv[2]
if (!mnemonicFile || !fs.existsSync(mnemonicFile)) {
    console.error(`usage: bun derive-pubkey.ts <mnemonic-file>`)
    process.exit(1)
}

const mnemonic = fs.readFileSync(mnemonicFile, "utf8").trim()
if (mnemonic.length === 0) {
    console.error(`error: mnemonic file is empty: ${mnemonicFile}`)
    process.exit(1)
}

const seedHash = Hashing.sha3_512(mnemonic)
const seedHashHex = uint8ArrayToHex(seedHash).slice(2)
const seedBytes = new TextEncoder().encode(seedHashHex)

await ucrypto.generateAllIdentities(seedBytes)
const identity = await ucrypto.getIdentity("ed25519")
if (!identity) {
    console.error("error: failed to derive ed25519 identity")
    process.exit(1)
}
console.log("0x" + identity.publicKey.toString("hex"))
