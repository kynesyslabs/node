import { SigningKey } from "ethers"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * `tlsnVerified` payloads for tests. The keys are derived from a fixed byte so
 * they are real secp256k1 points but are none of the test keys go/no-go
 * refuses: those are the ones checked into genesis files and vectors.
 */

/** Compressed secp256k1 public key (66 hex, no 0x) of the private key `byte` x 32. */
export function notaryKeyHex(byte: number): string {
    const priv = "0x" + byte.toString(16).padStart(2, "0").repeat(32)
    return new SigningKey(priv).compressedPublicKey.slice(2)
}

/** The uncompressed form (130 hex, 04 prefix) of the same key. */
export function uncompressedNotaryKeyHex(byte: number): string {
    const priv = "0x" + byte.toString(16).padStart(2, "0").repeat(32)
    return new SigningKey(priv).publicKey.slice(2)
}

/**
 * The pin of the verifier this build ships, read from its committed sha256
 * file: a filled genesis pins exactly that, or launch go/no-go refuses it.
 */
export const VERIFIER_WASM_SHA256 = readFileSync(
    join(import.meta.dir, "../../../../native/tlsn-verify/dist/demos_tlsn_verify.wasm.sha256"),
    "utf8",
)
    .trim()
    .split(/\s+/)[0]

/** A complete payload with two notary keys, as a filled genesis carries it. */
export function tlsnVerifiedPayload(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        notaryKeys: [
            { id: "demos-notary-1", alg: "k256", hex: notaryKeyHex(0x11) },
            { id: "demos-notary-standby", alg: "k256", hex: notaryKeyHex(0x22) },
        ],
        verifierWasmSha256: VERIFIER_WASM_SHA256,
        maxPresentationBytes: 65536,
        freshnessWindowSec: 3600,
        futureSkewSec: 60,
        ...extra,
    }
}
