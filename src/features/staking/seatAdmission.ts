/**
 * Pool admission limits for seat transactions under `nftValidatorGating`.
 * A stake or a challenge pays no gas there and makes the node read Solana,
 * so without them any key, funded or not, could have every node read Solana
 * for free. They are one node's admission policy: block apply never reads
 * them, so two nodes holding different limits still apply blocks alike.
 */

/** The seat transactions that read Solana when they are judged. */
export const SOLANA_SEAT_TX_TYPES: ReadonlySet<string> = new Set([
    "validatorStake",
    "validatorChallenge",
])

/** Seat transactions one sender may submit to this node per window. */
export const SEAT_TX_RATE_LIMIT = 3
export const SEAT_TX_RATE_WINDOW_MS = 60_000

/** Seat transactions one sender may hold in the pool at once. */
export const MAX_PENDING_SEAT_TXS_PER_SENDER = 2

/**
 * Seat transactions one merge, one received batch or one own-pool re-judge
 * reads Solana for. The merge is not held to the per-sender pool cap, so
 * without this a peer could make every member read Solana for any number of
 * them in one round. The rest are left out for the round, not dropped.
 */
export const SEAT_TXS_JUDGED_PER_BATCH = 16

/**
 * How long a batch waits for its seat verdicts. A verdict not back by then
 * counts as unanswered. Shorter than the merge's peer call timeout (10 s),
 * so a slow Solana cannot make the peer that sent the batch give up on us.
 */
export const SEAT_JUDGE_TIMEOUT_MS = 6_000

/**
 * How long a proof or a challenge a healthy endpoint refused stays refused
 * without another read. Bounded rather than kept for good: a refusal can
 * depend on what Solana and the seat table hold now (the wallet holding the
 * NFT, which seat a mint backs), and both can change back.
 */
export const REFUSED_VERDICT_TTL_MS = 10 * 60_000

/**
 * Keys are chosen by senders, so each map holds at most this many. Past it
 * the expired entries go, then the least recently written ones: emptying the
 * map would let 10k made-up senders reset every sender's rate limit.
 */
export const SEAT_ADMISSION_CACHE_CAP = 10_000

const attempts = new Map<string, number[]>()
const refused = new Map<string, { until: number; reason: string }>()

function bounded<V>(map: Map<string, V>, key: string, value: V, expired: (v: V) => boolean): void {
    // Re-inserted, so a map's insertion order is its write order.
    map.delete(key)
    if (map.size >= SEAT_ADMISSION_CACHE_CAP) {
        for (const [k, v] of map) if (expired(v)) map.delete(k)
        while (map.size >= SEAT_ADMISSION_CACHE_CAP) {
            const oldest = map.keys().next()
            if (oldest.done) break
            map.delete(oldest.value)
        }
    }
    map.set(key, value)
}

/**
 * Why `sender` may not submit another seat transaction now, or null, in
 * which case the attempt is counted. A refused attempt is not counted, so a
 * sender that keeps retrying is let in again once its window passes.
 */
export function seatRateRefusal(sender: string, now: number = Date.now()): string | null {
    const key = sender.toLowerCase()
    const recent = (attempts.get(key) ?? []).filter(at => now - at < SEAT_TX_RATE_WINDOW_MS)
    if (recent.length >= SEAT_TX_RATE_LIMIT) {
        bounded(attempts, key, recent, () => false)
        return (
            `Too many seat transactions from ${key}: at most ${SEAT_TX_RATE_LIMIT} ` +
            `every ${SEAT_TX_RATE_WINDOW_MS / 1000}s`
        )
    }
    recent.push(now)
    bounded(attempts, key, recent, times =>
        times.every(at => now - at >= SEAT_TX_RATE_WINDOW_MS),
    )
    return null
}

/**
 * Why a sender already holding `pendingTypes` in the pool may not add
 * another seat transaction, or null.
 */
export function seatPoolRefusal(pendingTypes: readonly unknown[]): string | null {
    const held = pendingTypes.filter(
        type => typeof type === "string" && SOLANA_SEAT_TX_TYPES.has(type),
    ).length
    return held >= MAX_PENDING_SEAT_TXS_PER_SENDER
        ? `Sender already holds ${held} seat transactions in the pool (at most ${MAX_PENDING_SEAT_TXS_PER_SENDER})`
        : null
}

/** The refused-verdict key of a stake: the proof and the validator it names. */
export function stakeVerdictKey(proofTx: string, validator: string): string {
    return `stake:${proofTx}:${validator.toLowerCase()}`
}

/** The refused-verdict key of a challenge: the evidence, the proof it answers, the seat. */
export function challengeVerdictKey(evidenceTx: string, proofTx: string, validator: string): string {
    return `challenge:${evidenceTx}:${proofTx}:${validator.toLowerCase()}`
}

/** The reason a verdict under `key` was refused, while it is still held. */
export function refusedVerdict(key: string, now: number = Date.now()): string | null {
    const held = refused.get(key)
    if (held === undefined) return null
    if (held.until <= now) {
        refused.delete(key)
        return null
    }
    return held.reason
}

/**
 * Hold a refusal a healthy endpoint gave. Only an `invalid` answer may come
 * here: an unanswered read says nothing about the proof, and holding it
 * would refuse a good seat for the length of a Solana outage.
 */
export function rememberRefused(key: string, reason: string, now: number = Date.now()): void {
    bounded(refused, key, { until: now + REFUSED_VERDICT_TTL_MS, reason }, v => v.until <= now)
}

const admitted = new Map<string, true>()

/**
 * Note this node's own verdict on seat tx `hash`. A round's candidate takes
 * an unlocked seat tx only once this node admitted it itself (at RPC
 * intake, from gossip, in a merge or a re-judge), never on a peer's word or
 * on a pool row kept across a restart. An unanswered read changes nothing.
 */
export function recordSeatVerdict(
    hash: string,
    verdict: { success: boolean; unreachable?: boolean },
): void {
    if (verdict.success) bounded(admitted, hash, true as const, () => false)
    else if (!verdict.unreachable) admitted.delete(hash)
}

export function seatAdmittedHere(hash: string): boolean {
    return admitted.has(hash)
}

export function resetSeatAdmissionForTesting(): void {
    attempts.clear()
    refused.clear()
    admitted.clear()
}
