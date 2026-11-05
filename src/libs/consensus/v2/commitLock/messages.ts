/**
 * The messages committee members sign under `commitLock`, without the fork
 * state that decides when they apply, so a client outside the node can
 * rebuild them from a block's height, round and hash.
 */

export const PREVOTE_DOMAIN = "demos-prevote"
export const PRECOMMIT_DOMAIN = "demos-precommit"

/** A round is the secretary timestamp of an attempt: a positive integer. */
export function isRound(value: unknown): value is number {
    return (
        typeof value === "number" && Number.isSafeInteger(value) && value > 0
    )
}

export function prevoteMessage(
    height: number,
    round: number,
    hash: string,
): string {
    return `${PREVOTE_DOMAIN}:${height}:${round}:${hash}`
}

export function precommitMessage(
    height: number,
    round: number,
    hash: string,
): string {
    return `${PRECOMMIT_DOMAIN}:${height}:${round}:${hash}`
}
