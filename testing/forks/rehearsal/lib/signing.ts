/**
 * Devnet-only tx-signing helper for the fork-activation rehearsal
 * harness.
 *
 * Scenarios up to 08 deliberately exercise read-only RPC paths so the
 * harness has no state coupling to keypairs. Scenario 10 (DEM-665
 * burn-spend rejection) needs a signed tx to drive the
 * `confirmTransaction` → `applyGasFeeSeparation` →
 * `GCRBalanceRoutines.apply` chain end-to-end. This module provides
 * the smallest possible signing surface for that purpose.
 *
 * Security:
 *   - DEVNET ONLY. The generated key lives in memory; never persisted.
 *   - Production wallets MUST use the SDK signing flow, not this helper.
 *   - The seed source is `crypto.randomBytes(32)`; if a deterministic
 *     key is needed across scenario runs (rare — only used for
 *     placeholder pre-seeding), pass `{ seedHex }` to
 *     {@link generateHarnessKeypair}.
 */

import { randomBytes } from "crypto"
import * as forge from "node-forge"
import { Cryptography } from "@kynesyslabs/demosdk/encryption"
import { serializeTransactionContent } from "@/forks"
import Hashing from "@/libs/crypto/hashing"

export interface HarnessKeypair {
    /** Ed25519 public key, lowercase hex with `0x` prefix (66 chars). */
    pubkeyHex: string
    /** Raw forge ed25519 private key — keep in-memory only. */
    privateKey: forge.pki.ed25519.NativeBuffer
    /** Raw forge ed25519 public key. */
    publicKey: forge.pki.ed25519.NativeBuffer
}

/**
 * Hex-encode a forge ed25519 public key buffer in the same shape the
 * node uses everywhere else: lowercase, `0x` + 64 hex chars.
 */
function pubkeyToHex(publicKey: forge.pki.ed25519.NativeBuffer): string {
    return (
        "0x" +
        Array.from(publicKey as unknown as Uint8Array)
            .map(b => b.toString(16).padStart(2, "0"))
            .join("")
    )
}

/**
 * Generate a fresh ed25519 keypair for in-memory harness use. Default
 * seed source is `crypto.randomBytes(32)`; pass an explicit `seedHex`
 * for determinism across scenario runs.
 *
 * Uses `Cryptography.newFromSeed`, the same primitive
 * `unifiedCrypto.generateIdentity("ed25519", seed)` uses internally —
 * keypair derivation is bit-identical to a production node start.
 */
export function generateHarnessKeypair(opts: { seedHex?: string } = {}): HarnessKeypair {
    const seed = opts.seedHex
        ? Buffer.from(opts.seedHex.replace(/^0x/, ""), "hex")
        : randomBytes(32)
    const kp = Cryptography.newFromSeed(seed)
    return {
        pubkeyHex: pubkeyToHex(kp.publicKey),
        privateKey: kp.privateKey,
        publicKey: kp.publicKey,
    }
}

/**
 * Sign a transaction's content with the harness keypair and stamp the
 * resulting hash + signature onto the tx, returning the tx in the
 * shape the node accepts via `manageExecution({ extra: "confirmTx",
 * data: tx })`.
 *
 * Mirrors `src/libs/blockchain/transaction.ts` Transaction.sign +
 * Transaction.hash exactly:
 *   1. `tx.hash = sha256(serializeTransactionContent(content, height))`
 *   2. `tx.signature = { type: "ed25519",
 *                       data: hex(ed25519.sign(serialize(content, height))) }`
 *
 * The `blockHeight` parameter is the same value the node uses in
 * `Transaction.sign` — `getSharedState.lastBlockNumber ?? 0`. For
 * post-fork scenarios pass a number ≥ activationHeight so the
 * fork-aware serializer takes the OS-string branch.
 */
export function signHarnessTx(
    kp: HarnessKeypair,
    content: any,
    blockHeight: number,
): { hash: string; signature: { type: "ed25519"; data: string } } {
    const serialized = serializeTransactionContent(content, blockHeight)
    const hash = Hashing.sha256(serialized)
    const sigBuf = Cryptography.sign(serialized, kp.privateKey)
    const sigHex =
        "0x" +
        Array.from(sigBuf as unknown as Uint8Array)
            .map(b => b.toString(16).padStart(2, "0"))
            .join("")
    return {
        hash,
        signature: { type: "ed25519", data: sigHex },
    }
}
