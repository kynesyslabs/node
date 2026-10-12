import GCR from "src/libs/blockchain/gcr/gcr"
import type { Validators } from "src/model/entities/Validators"
import { getSharedState } from "src/utilities/sharedState"
import log from "src/utilities/logger"

/** Staked validator set at the local head, cached per height. Keys are lowercase. */

let stakedSet = new Set<string>()
let stakedSetHeight = -1
let refreshing: Promise<void> | null = null
let selfStaked: boolean | null = null
let emptyWarnedAt = -1

type StakeListener = (staked: boolean) => void
const selfListeners = new Set<StakeListener>()

async function refresh(): Promise<void> {
    const head = getSharedState.lastBlockNumber ?? 0
    if (head === stakedSetHeight) return
    if (refreshing) return refreshing
    refreshing = (async () => {
        try {
            const validators = (await GCR.getGCRValidatorsAtBlock(
                head,
            )) as Validators[]
            stakedSet = new Set(
                validators
                    .map(v => v.address)
                    .filter((a): a is string => a !== null)
                    .map(a => a.toLowerCase()),
            )

            stakedSetHeight = stakedSet.size === 0 ? -1 : head
            if (stakedSet.size === 0 && emptyWarnedAt !== head) {
                emptyWarnedAt = head
                log.warning(
                    `[STAKED SET] no staked validators at head ${head}; not caching, will re-query`,
                )
            }
            notifySelf()
        } catch (e) {
            log.warning(
                `[STAKED SET] refresh failed at head ${head}: ${
                    e instanceof Error ? e.message : String(e)
                }`,
            )
        } finally {
            refreshing = null
        }
    })()
    return refreshing
}

function notifySelf(): void {
    const own = getSharedState.publicKeyHex?.toLowerCase()
    const now = own !== undefined && stakedSet.has(own)
    if (selfStaked === now) return
    const first = selfStaked === null
    selfStaked = now
    log.info(
        `[STAKED SET] this node is ${now ? "staked" : "not staked"} at height ${getSharedState.lastBlockNumber ?? 0}`,
    )
    if (first && !now) return
    for (const listener of selfListeners) {
        try {
            listener(now)
        } catch (e) {
            log.error(
                `[STAKED SET] stake listener threw: ${
                    e instanceof Error ? e.message : String(e)
                }`,
            )
        }
    }
}

/** Staked set at the current head. */
export async function getStakedSet(): Promise<ReadonlySet<string>> {
    await refresh()
    return stakedSet
}

/** Height the cached set was computed at, for log lines. */
export function getStakedSetHeight(): number {
    return stakedSetHeight
}

export async function isStaked(pubkey: string): Promise<boolean> {
    await refresh()
    return stakedSet.has(pubkey.toLowerCase())
}

/** Whether this node's own key is in the staked set at the current head. */
export async function isSelfStaked(): Promise<boolean> {
    await refresh()
    return selfStaked === true
}

/** Register a listener for own stake flips; called immediately if already staked. */
export function onSelfStakeChange(listener: StakeListener): () => void {
    selfListeners.add(listener)
    if (selfStaked === true) {
        try {
            listener(true)
        } catch (e) {
            log.error(
                `[STAKED SET] stake listener threw: ${
                    e instanceof Error ? e.message : String(e)
                }`,
            )
        }
    }
    return () => selfListeners.delete(listener)
}

/**
 * Drop the cached set so the next lookup re-queries at the current head.
 */
export function invalidateStakedSet(): void {
    stakedSetHeight = -1
}

// eslint-disable-next-line @typescript-eslint/naming-convention
export function __resetStakedSet(): void {
    emptyWarnedAt = -1
    stakedSet = new Set()
    stakedSetHeight = -1
    refreshing = null
    selfStaked = null
    selfListeners.clear()
}
