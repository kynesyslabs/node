/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import type { TlsnNotaryKey, TlsnVerifiedParams } from "./forkConfig"

/**
 * Payload rules of the `tlsnVerified` fork. A leaf module so the node's
 * loader and the launch tooling refuse exactly the same payloads.
 */

/** The payload fields, beside `activationHeight` and `description`. */
export const TLSN_VERIFIED_PAYLOAD_FIELDS = [
    "notaryKeys",
    "verifierWasmSha256",
    "maxPresentationBytes",
    "freshnessWindowSec",
    "futureSkewSec",
] as const

const ENTRY_FIELDS: ReadonlySet<string> = new Set([
    "activationHeight",
    "description",
    ...TLSN_VERIFIED_PAYLOAD_FIELDS,
])
const KEY_FIELDS: ReadonlySet<string> = new Set(["id", "alg", "hex"])

/** At most this many notary keys: a primary, a standby and room for a rotation overlap. */
export const TLSN_MAX_NOTARY_KEYS = 8
/** Bounds that catch a unit slip (KB for bytes, minutes for seconds) at boot. */
export const TLSN_MAX_PRESENTATION_BYTES_RANGE = [1024, 1_048_576] as const
export const TLSN_FRESHNESS_WINDOW_SEC_RANGE = [1, 604_800] as const
export const TLSN_FUTURE_SKEW_SEC_RANGE = [0, 600] as const

const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
// The verifier reports a k256 key as its 33-byte SEC1 compressed form
const K256_COMPRESSED_PATTERN = /^0[23][0-9a-f]{64}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/

// secp256k1 field prime
const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
    let result = 1n
    let b = base % mod
    let e = exp
    while (e > 0n) {
        if (e & 1n) result = (result * b) % mod
        b = (b * b) % mod
        e >>= 1n
    }
    return result
}

/**
 * Whether a compressed key names a point on secp256k1: x below the field
 * prime and x^3 + 7 a square mod p. A well-formed hex string that is not a
 * point would pass the format check and match no presentation, which hides a
 * copy error in the genesis until the first identity link fails.
 */
export function isSecp256k1CompressedPoint(hex: string): boolean {
    if (!K256_COMPRESSED_PATTERN.test(hex)) return false
    const x = BigInt("0x" + hex.slice(2))
    if (x >= P) return false
    const rhs = (modPow(x, 3n, P) + 7n) % P
    return rhs === 0n || modPow(rhs, (P - 1n) / 2n, P) === 1n
}

function isIntIn(value: unknown, [min, max]: readonly [number, number]): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
}

const show = (value: unknown) => JSON.stringify(value)?.slice(0, 120) ?? String(value)

export function notaryKeyProblems(raw: unknown, at: string): string[] {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        return [`${at} must be an object {id, alg, hex}, got ${show(raw)}`]
    }
    const key = raw as Record<string, unknown>
    const problems = Object.keys(key)
        .filter(f => !KEY_FIELDS.has(f))
        .map(f => `${at} has unknown field "${f}"`)
    if (typeof key.id !== "string" || !KEY_ID_PATTERN.test(key.id)) {
        problems.push(`${at}.id must match ${KEY_ID_PATTERN.source}, got ${show(key.id)}`)
    }
    if (key.alg !== "k256") {
        problems.push(
            `${at}.alg must be "k256" (the notary signs with secp256k1, the only curve the prover requests), got ${show(key.alg)}`,
        )
    }
    if (typeof key.hex !== "string" || !K256_COMPRESSED_PATTERN.test(key.hex)) {
        problems.push(
            `${at}.hex must be a 33-byte compressed secp256k1 public key, lowercase 02 or 03 + 64 hex, got ${show(key.hex)}`,
        )
    } else if (!isSecp256k1CompressedPoint(key.hex)) {
        problems.push(`${at}.hex ${key.hex} is not a point on secp256k1`)
    }
    return problems
}

/**
 * Why a `tlsnVerified` genesis entry is refused, one line per problem; empty
 * when it is accepted. A scheduled entry needs the whole payload. An
 * unscheduled one may leave the payload out, as the code default does, but a
 * payload it does carry is held to the same rules. Unknown fields are refused
 * at every height, so a misspelt field cannot silently fall back to nothing.
 */
export function tlsnVerifiedProblems(entry: Record<string, unknown>, scheduled: boolean): string[] {
    const at = "fork \"tlsnVerified\""
    const problems = Object.keys(entry)
        .filter(f => !ENTRY_FIELDS.has(f))
        .map(f => `${at} has unknown field "${f}"`)
    const present = TLSN_VERIFIED_PAYLOAD_FIELDS.filter(f => Object.hasOwn(entry, f))
    if (!scheduled && present.length === 0) return problems

    const keys = entry.notaryKeys
    if (!Array.isArray(keys) || keys.length === 0 || keys.length > TLSN_MAX_NOTARY_KEYS) {
        problems.push(
            `${at}.notaryKeys must be a list of 1 to ${TLSN_MAX_NOTARY_KEYS} keys, got ${show(keys)}`,
        )
    } else {
        keys.forEach((key, i) => problems.push(...notaryKeyProblems(key, `${at}.notaryKeys[${i}]`)))
        const ids = keys.map(k => (k as { id?: unknown })?.id).filter(v => typeof v === "string")
        const hexes = keys.map(k => (k as { hex?: unknown })?.hex).filter(v => typeof v === "string")
        for (const [field, values] of [["id", ids], ["hex", hexes]] as const) {
            const repeated = values.filter((v, i) => values.indexOf(v) !== i)
            if (repeated.length > 0) {
                problems.push(`${at}.notaryKeys repeats ${field} ${[...new Set(repeated)].join(", ")}`)
            }
        }
    }
    const wasm = entry.verifierWasmSha256
    if (typeof wasm !== "string" || !SHA256_PATTERN.test(wasm)) {
        problems.push(`${at}.verifierWasmSha256 must be the verifier wasm's sha256, 64 lowercase hex, got ${show(wasm)}`)
    }
    const ranges = [
        ["maxPresentationBytes", TLSN_MAX_PRESENTATION_BYTES_RANGE],
        ["freshnessWindowSec", TLSN_FRESHNESS_WINDOW_SEC_RANGE],
        ["futureSkewSec", TLSN_FUTURE_SKEW_SEC_RANGE],
    ] as const
    for (const [field, range] of ranges) {
        if (!isIntIn(entry[field], range)) {
            problems.push(`${at}.${field} must be an integer from ${range[0]} to ${range[1]}, got ${show(entry[field])}`)
        }
    }
    return problems
}

/**
 * The payload of an entry `tlsnVerifiedProblems` accepted with a payload, as
 * a frozen copy: the shared fork config must not change under a caller that
 * holds the key list.
 */
export function tlsnVerifiedParamsOf(entry: Record<string, unknown>): TlsnVerifiedParams {
    const keys = (entry.notaryKeys as TlsnNotaryKey[]).map(k =>
        Object.freeze({ id: k.id, alg: k.alg, hex: k.hex }),
    )
    return Object.freeze({
        notaryKeys: Object.freeze(keys),
        verifierWasmSha256: entry.verifierWasmSha256 as string,
        maxPresentationBytes: entry.maxPresentationBytes as number,
        freshnessWindowSec: entry.freshnessWindowSec as number,
        futureSkewSec: entry.futureSkewSec as number,
    })
}
