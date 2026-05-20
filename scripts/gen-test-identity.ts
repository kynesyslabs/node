/**
 * Generate a fresh ed25519 identity for multi-node interop tests
 * (epic #16). Writes the mnemonic + pubkey to .test-identity/ (gitignored)
 * and prints the pubkey for splicing into data/genesis.json validators[].
 *
 * Deterministic on re-run: refuses to overwrite an existing identity file
 * unless --force is passed.
 */

import * as fs from "fs"
import * as path from "path"
import { Demos } from "@kynesyslabs/demosdk/websdk"
import { ucrypto, Hashing, uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"

const OUT_DIR = path.join(process.cwd(), ".test-identity")
// Optional --name <slug> writes to <slug>.mnemonic / <slug>.pubkey instead
// of the default mnemonic/pubkey files. Lets multi-node tests provision
// distinct identities side-by-side without overwriting the host's keypair.
const args = process.argv.slice(2)
const nameIdx = args.indexOf("--name")
const NAME_RAW = nameIdx >= 0 ? (args[nameIdx + 1] ?? null) : null
if (nameIdx >= 0 && !NAME_RAW) {
    console.error("error: --name requires a value")
    process.exit(1)
}
const NAME_RE = /^[a-zA-Z0-9._-]+$/
if (NAME_RAW !== null && !NAME_RE.test(NAME_RAW)) {
    console.error(
        `error: --name value "${NAME_RAW}" contains invalid characters; only [a-zA-Z0-9._-] are allowed`,
    )
    process.exit(1)
}
const NAME = NAME_RAW
const MNEMONIC_FILE = path.join(OUT_DIR, NAME ? `${NAME}.mnemonic` : "mnemonic")
const PUBKEY_FILE = path.join(OUT_DIR, NAME ? `${NAME}.pubkey` : "pubkey")
const FORCE = args.includes("--force")

if (fs.existsSync(MNEMONIC_FILE) && !FORCE) {
    const existing = fs.readFileSync(PUBKEY_FILE, "utf8").trim()
    console.log(
        `[gen-test-identity] identity already exists at ${OUT_DIR}; pubkey=${existing}`,
    )
    console.log(`[gen-test-identity] pass --force to regenerate`)
    process.exit(0)
}

const demos = new Demos()
const mnemonic = demos.newMnemonic()

// Mirror src/libs/identity/identity.ts:mnemonicToSeed exactly: sha3_512
// over the raw mnemonic, then the hex-string of that hash is the seed.
// Using bip39.mnemonicToSeed produces a DIFFERENT key (PBKDF2 path).
const seedHash = Hashing.sha3_512(mnemonic)
const seedHashHex = uint8ArrayToHex(seedHash).slice(2)
const seedBytes = new TextEncoder().encode(seedHashHex)

await ucrypto.generateAllIdentities(seedBytes)
const identity = await ucrypto.getIdentity("ed25519")
const pubkey = "0x" + identity.publicKey.toString("hex")

fs.mkdirSync(OUT_DIR, { recursive: true })
fs.writeFileSync(MNEMONIC_FILE, mnemonic, { mode: 0o600 })
fs.writeFileSync(PUBKEY_FILE, pubkey, { mode: 0o644 })

console.log(`[gen-test-identity] generated identity at ${OUT_DIR}`)
console.log(`[gen-test-identity] pubkey=${pubkey}`)
console.log(`[gen-test-identity] mnemonic at ${MNEMONIC_FILE} (mode 0600)`)
