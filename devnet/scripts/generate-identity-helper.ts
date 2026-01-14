#!/usr/bin/env bun
/**
 * Helper script to generate a single BIP39 identity with derived public key
 * Usage: bun generate-identity-helper.ts
 *
 * Outputs:
 * MNEMONIC:<mnemonic phrase>
 * PUBKEY:0x<hex public key>
 */

import { Demos } from "@kynesyslabs/demosdk/websdk"
import {
    Hashing,
    ucrypto,
    uint8ArrayToHex,
} from "@kynesyslabs/demosdk/encryption"

// Generate new mnemonic
const demos = new Demos()
const mnemonic = demos.newMnemonic()

// Derive seed (matching identity.ts mnemonicToSeed logic)
// Uses raw mnemonic string to match wallet/SDK derivation
const hashable = mnemonic.trim()
const seedHash = Hashing.sha3_512(hashable)
const seedHashHex = uint8ArrayToHex(seedHash).slice(2) // Remove 0x prefix
const seed = new TextEncoder().encode(seedHashHex)

// Generate all identities from seed
await ucrypto.generateAllIdentities(seed)

// Get the Ed25519 identity (lowercase to match SigningAlgorithm type)
const identity = await ucrypto.getIdentity("ed25519")

// uint8ArrayToHex already includes 0x prefix
const pubkeyHex = uint8ArrayToHex(identity.publicKey)

console.log("MNEMONIC:" + mnemonic)
console.log("PUBKEY:" + pubkeyHex)
