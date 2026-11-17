#!/usr/bin/env bun
/**
 * Client wallets for the TLSN e2e, derived the way the node and the SDK
 * derive an ed25519 account from a mnemonic.
 *
 *   cd <inputs dir> && bun <harness>/wallets.ts
 *
 * Writes wallets.secret.json (mode 600: mnemonics) and genesis-balances.json
 * ([address, DEM] pairs run.sh adds to genesis) into the working directory.
 */
import { chmodSync, writeFileSync } from "node:fs"
import { Demos } from "@kynesyslabs/demosdk/websdk"
import { Hashing, ucrypto, uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"

export interface Wallet {
    label: string
    address: string
    mnemonic: string
    fund: string
}

/** alice drives the flow; bob is the other sender of the negative cases. */
export const WALLET_LABELS = ["alice", "bob"] as const
/** Whole DEM: requests burn 1, stores 1 + 1 per KB. */
const FUND_DEM = 1000n

async function derive(mnemonic: string): Promise<string> {
    const seedHashHex = uint8ArrayToHex(Hashing.sha3_512(mnemonic.trim()) as Uint8Array).slice(2)
    await ucrypto.generateAllIdentities(new TextEncoder().encode(seedHashHex))
    const identity = await ucrypto.getIdentity("ed25519")
    return uint8ArrayToHex(identity.publicKey as Uint8Array).toLowerCase()
}

if (import.meta.main) {
    const demos = new Demos()
    const wallets: Record<string, Wallet> = {}
    for (const label of WALLET_LABELS) {
        const mnemonic = demos.newMnemonic()
        wallets[label] = { label, address: await derive(mnemonic), mnemonic, fund: FUND_DEM.toString() }
    }
    const file = "wallets.secret.json"
    writeFileSync(file, JSON.stringify(wallets, null, 2), { mode: 0o600 })
    chmodSync(file, 0o600)
    // Genesis balances are DEM: the osDenomination migration at block 0 scales them to OS.
    writeFileSync("genesis-balances.json", JSON.stringify(Object.values(wallets).map(w => [w.address, w.fund]), null, 2))
    console.log(`wallets: ${Object.keys(wallets).length} funded with ${FUND_DEM} DEM each`)
    process.exit(0)
}
