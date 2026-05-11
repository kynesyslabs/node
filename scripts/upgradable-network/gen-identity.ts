#!/usr/bin/env bun
/**
 * Generate a BIP39 identity compatible with ./run -i <path>.
 *
 * Stores the mnemonic in <path> (plain text, matching the default
 * .demos_identity format) and writes <path>.pub alongside with the
 * derived ed25519 public-key hex so shell scripts can read it without
 * re-running crypto.
 *
 *   bun scripts/devnet-gen-identity.ts .devnet/identity_1
 */

import { existsSync, writeFileSync } from "node:fs"
import * as bip39 from "bip39"
import { Demos } from "@kynesyslabs/demosdk/websdk"
import { uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"

async function main() {
    const target = process.argv[2]
    if (!target) {
        console.error(
            "usage: bun scripts/devnet-gen-identity.ts <path>\n" +
                "writes the mnemonic to <path> and pubkey hex to <path>.pub",
        )
        process.exit(1)
    }

    if (existsSync(target)) {
        console.error(`refusing to overwrite ${target}`)
        process.exit(1)
    }

    const mnemonic = bip39.generateMnemonic(256)
    const demos = new Demos()
    await demos.connectWallet(mnemonic)
    const { publicKey } = await demos.crypto.getIdentity("ed25519")
    const pubHex = uint8ArrayToHex(publicKey as Uint8Array).replace(/^0x/, "")

    writeFileSync(target, mnemonic, { mode: 0o600 })
    writeFileSync(`${target}.pub`, pubHex + "\n", { mode: 0o644 })
    console.log(`wrote ${target} (mnemonic) and ${target}.pub (${pubHex})`)
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
