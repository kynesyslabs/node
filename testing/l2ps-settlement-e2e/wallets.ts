#!/usr/bin/env bun
/**
 * Client wallets for the L2PS settlement e2e, derived the way the node and the
 * SDK derive an ed25519 account from a mnemonic (as
 * testing/devnet/scripts/generate-identity-helper.ts does).
 *
 *   bun wallets.ts <inputs dir>
 *
 * Writes <inputs>/wallets.secret.json (mode 600: mnemonics) and
 * <inputs>/genesis-balances.json ([address, DEM] pairs run.sh adds to genesis).
 * Batch sizes come from the node's settlement encoding, never assumed.
 */
import { chmodSync, writeFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { Demos } from "@kynesyslabs/demosdk/websdk"
import { Hashing, ucrypto, uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import { SETTLEMENT_TRANSFERS } from "../../src/libs/l2ps/settlement/encoding"

export const DEM = 1_000_000_000n

export interface WalletSpec {
    label: string
    /** OS credited at genesis; 0 keeps the account out of genesis. */
    fund: bigint
    /** false: an address only, nobody holds its key (a receiver that never signs). */
    keyed: boolean
}

/**
 * Every account the scenarios touch. Groups never share an account, so one
 * scenario's batches cannot make another's proofs stale.
 */
export function walletPlan(n: number = SETTLEMENT_TRANSFERS): WalletSpec[] {
    const plan: WalletSpec[] = []
    const add = (label: string, fund: bigint, keyed = true) => plan.push({ label, fund, keyed })
    // happy path: n single senders, one sender of three consecutive transfers
    for (let i = 0; i < n; i++) add(`hs${i}`, 1000n * DEM)
    add("hm", 1000n * DEM)
    for (let i = 0; i < n; i++) add(`hr${i}`, i % 2 === 0 ? 1n * DEM : 0n, false)
    add("hx", 0n, false)
    // failure cases
    add("fsig", 100n * DEM)
    add("fold", 100n * DEM)
    add("fahead", 100n * DEM)
    add("fover", 5n * DEM)
    add("fzero", 100n * DEM)
    add("fdbl", 15n * DEM)
    add("fovx", 15n * DEM)
    add("fr", 1n * DEM, false)
    add("frA", 0n, false)
    add("frB", 0n, false)
    add("frC", 0n, false)
    add("frD", 0n, false)
    add("fz", 0n, false)
    // member restart
    for (let i = 0; i < n; i++) add(`rs${i}`, 1000n * DEM)
    for (let i = 0; i < n; i++) add(`rr${i}`, 0n, false)
    // throughput, with L1 load beside it
    for (let i = 0; i < 3 * n; i++) add(`tp${i}`, 1000n * DEM)
    for (let i = 0; i < 3 * n; i++) add(`tq${i}`, 0n, false)
    add("l1", 1_000_000n * DEM)
    return plan
}

export interface Wallet {
    label: string
    address: string
    mnemonic?: string
    fund: string
}

async function derive(mnemonic: string): Promise<string> {
    const seedHashHex = uint8ArrayToHex(Hashing.sha3_512(mnemonic.trim()) as Uint8Array).slice(2)
    await ucrypto.generateAllIdentities(new TextEncoder().encode(seedHashHex))
    const identity = await ucrypto.getIdentity("ed25519")
    return uint8ArrayToHex(identity.publicKey as Uint8Array).toLowerCase()
}

if (import.meta.main) {
    const inputs = process.argv[2]
    if (!inputs) {
        console.error("usage: bun wallets.ts <inputs dir>")
        process.exit(2)
    }
    const demos = new Demos()
    const wallets: Record<string, Wallet> = {}
    for (const spec of walletPlan()) {
        if (spec.keyed) {
            const mnemonic = demos.newMnemonic()
            wallets[spec.label] = { label: spec.label, address: await derive(mnemonic), mnemonic, fund: spec.fund.toString() }
        } else {
            wallets[spec.label] = { label: spec.label, address: "0x" + randomBytes(32).toString("hex"), fund: spec.fund.toString() }
        }
    }
    const file = `${inputs}/wallets.secret.json`
    writeFileSync(file, JSON.stringify(wallets, null, 2), { mode: 0o600 })
    chmodSync(file, 0o600)
    // Genesis balances are DEM: the osDenomination migration at block 0 scales them to OS.
    const balances = Object.values(wallets)
        .filter(w => BigInt(w.fund) > 0n)
        .map(w => {
            if (BigInt(w.fund) % DEM !== 0n) throw new Error(`${w.label}: genesis funds whole DEM only`)
            return [w.address, (BigInt(w.fund) / DEM).toString()]
        })
    writeFileSync(`${inputs}/genesis-balances.json`, JSON.stringify(balances, null, 2))
    console.log(`wallets: ${Object.keys(wallets).length} (${balances.length} funded at genesis), N=${SETTLEMENT_TRANSFERS}`)
    process.exit(0)
}
