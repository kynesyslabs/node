/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { getSharedState } from "@/utilities/sharedState"
import type { TlsnNotaryKey, TlsnVerifiedParams } from "./forkConfig"
import { isForkActive } from "./forkGates"

/**
 * The `tlsnVerified` payload that applies at `height`, or null while the fork
 * is not active there. Callers judge a presentation against the keys and
 * limits returned for the height of the block it lands in, so every validator
 * reads the same values for the same block.
 *
 * Throws when the fork is active without its payload: the loader refuses such
 * a genesis, so only a hand-built config reaches this, and verifying with no
 * key list would refuse or accept differently from the rest of the network.
 */
export function tlsnVerifiedParams(height: number): TlsnVerifiedParams | null {
    if (!isForkActive("tlsnVerified", height)) return null
    const config = getSharedState.forkConfig.tlsnVerified
    const {
        notaryKeys,
        verifierWasmSha256,
        maxPresentationBytes,
        freshnessWindowSec,
        futureSkewSec,
    } = config
    if (
        notaryKeys === undefined ||
        verifierWasmSha256 === undefined ||
        maxPresentationBytes === undefined ||
        freshnessWindowSec === undefined ||
        futureSkewSec === undefined
    ) {
        throw new Error(
            `[FORKS] tlsnVerified is active at ${height} without its payload ` +
                "(notaryKeys, verifierWasmSha256, maxPresentationBytes, freshnessWindowSec, futureSkewSec)",
        )
    }
    return { notaryKeys, verifierWasmSha256, maxPresentationBytes, freshnessWindowSec, futureSkewSec }
}

/** Whether `key` may sign for the block at `blockHeight`: `validFrom` <= height < `validUntil`. */
export function notaryKeyValidAt(key: TlsnNotaryKey, blockHeight: number): boolean {
    return (
        (key.validFrom === undefined || blockHeight >= key.validFrom) &&
        (key.validUntil === undefined || blockHeight < key.validUntil)
    )
}

/**
 * Whether `alg`/`hex` (a verifier's `verifyingKey`) is a notary key listed for
 * the block applied on tip `height`. The fork is judged at the tip, as every
 * fork is; a key's range at the block itself, `height + 1`, which at
 * admission is the next block this node would produce.
 */
export function isTrustedNotaryKey(height: number, alg: string, hex: string): boolean {
    const params = tlsnVerifiedParams(height)
    if (!params) return false
    const wanted = hex.toLowerCase()
    return params.notaryKeys.some(k => k.alg === alg && k.hex === wanted && notaryKeyValidAt(k, height + 1))
}
