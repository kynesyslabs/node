/**
 * Shared canonicalization helper for fork-gated amount/fee fields.
 *
 * Background: P3a's `serializerGate.ts` and the native-transaction
 * executor both need to take a wire-format amount value (`number`,
 * `string`, or `bigint`) and reduce it to the same canonical `bigint`
 * so the hash bound to the signature and the balance arithmetic
 * applied during execution agree on the same magnitude.
 *
 * Before this helper existed (myc#76, GH#3213223280), the post-fork
 * serializer applied `denomination.demToOs` to legacy `number` inputs
 * before hashing while the executor only `BigInt(...)`-coerced the
 * wire value. For a pre-3.1.0 SDK client whose tx lands in a post-fork
 * block this produced a 1e9× discrepancy between the signed amount and
 * the applied amount.
 *
 * Both callers MUST go through {@link canonicalizeAmountToOs} so the
 * fork boundary stays self-consistent.
 *
 * Contract:
 *  - **Post-fork** (`forkActive === true`): output is the canonical OS
 *    `bigint` matching `serializerGate.toOsBigint`. `bigint` inputs
 *    are treated as already-OS, `string` inputs are parsed as OS via
 *    `denomination.parseOsString`, `number` inputs are scaled DEM→OS
 *    via `denomination.demToOs` (the path that exists for legacy
 *    pre-3.1.0 clients submitting against a post-fork node).
 *  - **Pre-fork** (`forkActive === false`): output is the DEM-magnitude
 *    `bigint` of the wire value (a plain `BigInt(...)` coercion).
 *    Pre-fork wire never carries OS magnitudes and pre-fork balance
 *    storage is also DEM, so the executor's existing balance arithmetic
 *    keeps working bit-identically to pre-P3a behaviour.
 *
 * The pre-fork branch deliberately does NOT multiply by OS_PER_DEM:
 * the executor's balance comparison runs against a DEM-magnitude
 * `getGCRNativeBalance` pre-fork, and applying the migration scaling
 * here would cause every transfer to fail the funds check (1e9× too
 * large). The helper's job is to give the executor whatever magnitude
 * the SAME serializer's hashing path used — pre-fork the serializer
 * does NOT canonicalize (`JSON.stringify(content)` is the raw wire
 * shape), so neither does this helper.
 *
 * @see decimal_planning/SPEC.md §3 (P3 dual-rule paths)
 * @see src/forks/serializerGate.ts (`toOsBigint`)
 */
import { denomination } from "@kynesyslabs/demosdk"

/**
 * Coerce a wire-format amount/fee value to the canonical `bigint` the
 * fork-active state expects (OS post-fork, DEM pre-fork).
 *
 * Throws when the input is not a non-negative finite amount (NaN,
 * Infinity, negative, malformed string, etc.) so the caller can
 * surface a clear error rather than silently mis-counting balances.
 *
 * @param wireValue - The amount as it appears on the wire / on the entity.
 * @param forkActive - Result of `isForkActive('osDenomination', height)`.
 * @returns Canonical amount as a `bigint`.
 */
export function canonicalizeAmountToOs(
    wireValue: number | string | bigint | null | undefined,
    forkActive: boolean,
): bigint {
    if (wireValue === null || wireValue === undefined) {
        return 0n
    }

    if (typeof wireValue === "bigint") {
        if (wireValue < 0n) {
            throw new Error(
                `canonicalizeAmountToOs: negative bigint amount ${wireValue.toString()} is not a valid magnitude`,
            )
        }
        // Both branches passthrough: pre-fork DEM-bigint stays DEM,
        // post-fork OS-bigint stays OS.
        return wireValue
    }

    if (typeof wireValue === "number") {
        if (!Number.isFinite(wireValue)) {
            throw new Error(
                `canonicalizeAmountToOs: non-finite number ${wireValue} cannot be canonicalised`,
            )
        }
        if (wireValue < 0) {
            throw new Error(
                `canonicalizeAmountToOs: negative number ${wireValue} is not a valid amount`,
            )
        }
        if (forkActive) {
            // Post-fork: legacy `number` wire is DEM; scale to OS to match
            // the serializer's `transformToOsTransactionContent`.
            return denomination.demToOs(wireValue)
        }
        // Pre-fork: `number` is the legacy DEM wire shape; the executor's
        // balance arithmetic also runs in DEM. No scaling.
        if (!Number.isInteger(wireValue)) {
            throw new Error(
                `canonicalizeAmountToOs: pre-fork DEM number must be an integer, got ${wireValue}`,
            )
        }
        return BigInt(wireValue)
    }

    // String input.
    const trimmed = wireValue.trim()
    if (trimmed.length === 0) {
        throw new Error(
            "canonicalizeAmountToOs: empty string is not a valid amount",
        )
    }
    let parsed: bigint
    try {
        if (forkActive) {
            // Post-fork: OS decimal integer string.
            parsed = denomination.parseOsString(trimmed)
        } else {
            // Pre-fork: DEM integer string.
            parsed = BigInt(trimmed)
        }
    } catch (e) {
        throw new Error(
            `canonicalizeAmountToOs: malformed ${forkActive ? "OS" : "DEM"} string ${JSON.stringify(
                wireValue,
            )} — ${(e as Error).message}`,
        )
    }
    if (parsed < 0n) {
        throw new Error(
            `canonicalizeAmountToOs: negative string amount ${JSON.stringify(
                wireValue,
            )} is not valid`,
        )
    }
    return parsed
}
