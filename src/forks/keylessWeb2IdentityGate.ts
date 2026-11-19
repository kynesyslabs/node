import { getSharedState } from "@/utilities/sharedState"
import { TLSN_CONTEXTS, TLSN_KEYLESS_CONTEXTS } from "@/libs/identity/web2Contexts"
import { isForkActive } from "./forkGates"

/**
 * Web2 contexts whose `web2_identity_assign` proof a validator can only
 * check by calling the provider with its own credentials (GitHub token,
 * Discord bot token, RapidAPI key). Telegram is not one: its attestation is
 * signed by the Demos bot and checked offline.
 */
export const KEYED_WEB2_CONTEXTS: ReadonlySet<string> = new Set(["github", "discord", "twitter"])

/**
 * Whether `keylessWeb2Identity` binds. Judged at the tip at admission and at
 * apply alike, as `tlsnVerified` is, so a link admitted against the tip is
 * judged by the same rule when the block on that tip applies.
 */
export function keylessWeb2IdentityActive(height = getSharedState.lastBlockNumber ?? 0): boolean {
    return isForkActive("keylessWeb2Identity", height)
}

/**
 * Why a `web2_identity_assign` of `context` is refused under the fork, or
 * null when the rule does not refuse it.
 */
export function keylessWeb2AssignRefusal(context: unknown): string | null {
    if (typeof context !== "string" || !KEYED_WEB2_CONTEXTS.has(context)) return null
    if (!keylessWeb2IdentityActive()) return null
    return (
        `${context} accounts link through TLSNotary (tlsn_identity_assign) on this network; ` +
        "the web2 proof path is closed for them"
    )
}

/** The contexts a TLSN link or unlink may name now. */
export function tlsnLinkContexts(): ReadonlySet<string> {
    return keylessWeb2IdentityActive() ? TLSN_KEYLESS_CONTEXTS : TLSN_CONTEXTS
}
