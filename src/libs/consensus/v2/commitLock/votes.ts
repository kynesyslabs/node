import { verifiedSignersOf } from "@/libs/blockchain/validation/verifyBlock"
import { countPrecommitEquivocation } from "@/features/metrics/consensusMetrics"
import { getSharedState } from "src/utilities/sharedState"
import log from "src/utilities/logger"
import { verifierThreshold } from "../quorum"
import { isRound, precommitMessage, prevoteMessage } from "./domain"

/**
 * Votes under commitLock are counted against the bound committee with the
 * threshold sync applies to a block, so a proof of lock and a certificate
 * need exactly what a block needs: 2/3 + 1 of a full committee.
 */
export function commitQuorum(committeeSize: number): number {
    return verifierThreshold(getSharedState.shardSize, committeeSize, true)
}

export function isSignatureMap(value: unknown): value is Record<string, string> {
    return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Object.values(value).every(v => typeof v === "string")
    )
}

/** Committee members whose prevote for `hash` in `round` verifies. */
export async function verifiedPrevoters(
    height: number,
    round: number,
    hash: string,
    signatures: Record<string, unknown>,
    committee: string[],
): Promise<Set<string>> {
    if (!isRound(round)) return new Set()
    return await verifiedSignersOf(
        prevoteMessage(height, round, hash),
        signatures,
        new Set(committee),
    )
}

/** Committee members whose precommit for `hash` in `round` verifies. */
export async function verifiedPrecommitters(
    height: number,
    round: number,
    hash: string,
    signatures: Record<string, unknown>,
    committee: string[],
): Promise<Set<string>> {
    if (!isRound(round)) return new Set()
    return await verifiedSignersOf(
        precommitMessage(height, round, hash),
        signatures,
        new Set(committee),
    )
}

/**
 * The prevotes of `signatures` that form a proof of lock for `hash` in
 * `round`, or null when fewer than a quorum of committee members verify.
 * Only the verified committee prevotes are kept, so a lock never stores
 * anything a peer could not check again.
 */
export async function proofOfLock(
    height: number,
    round: number,
    hash: string,
    signatures: unknown,
    committee: string[],
): Promise<Record<string, string> | null> {
    if (!isSignatureMap(signatures)) return null
    if (Object.keys(signatures).length > committee.length * 2) return null
    const voters = await verifiedPrevoters(
        height,
        round,
        hash,
        signatures,
        committee,
    )
    if (voters.size < commitQuorum(committee.length)) return null
    const pol: Record<string, string> = {}
    for (const id of voters) pol[id] = signatures[id]
    return pol
}

interface SeenPrecommit {
    round: number
    hash: string
    signature: string
}

// Rounds kept per member: enough for the retries of one height.
const ROUNDS_PER_MEMBER = 16

/**
 * Verified committee precommits seen at the current height, from our own
 * round, precommit requests and replies. A certificate is drawn from one
 * round only. Two precommits by one member for different blocks in the
 * same round are proof that the member broke the lock rule; for different
 * blocks in different rounds they are what a lock move looks like.
 */
export class PrecommitBook {
    private height: number | null = null
    private byMember = new Map<string, SeenPrecommit[]>()
    private listeners = new Set<() => void>()

    /**
     * Call `listener` after each precommit the book takes in, whichever
     * path delivered it. Returns the call that removes it.
     */
    onRecord(listener: () => void): () => void {
        this.listeners.add(listener)
        return () => {
            this.listeners.delete(listener)
        }
    }

    /** Record a precommit whose signature the caller verified. */
    record(
        height: number,
        round: number,
        hash: string,
        member: string,
        signature: string,
    ): "new" | "known" | "equivocation" | "stale" {
        if (this.height === null || height > this.height) {
            this.height = height
            this.byMember.clear()
        }
        if (height < this.height) return "stale"

        const seen = this.byMember.get(member) ?? []
        let outcome: "new" | "known" | "equivocation" = "new"
        for (const prior of seen) {
            if (prior.round === round && prior.hash === hash) return "known"
            if (prior.hash === hash) continue
            if (prior.round === round) {
                outcome = "equivocation"
                countPrecommitEquivocation()
                log.error(
                    `[commitLock] Equivocation: ${member} precommitted ${prior.hash} and ${hash} ` +
                        `at height ${height} in round ${round} (signatures ${prior.signature}, ${signature})`,
                )
            } else {
                log.warning(
                    `[commitLock] ${member} precommitted ${prior.hash} in round ${prior.round} and ` +
                        `${hash} in round ${round} at height ${height}: a lock move`,
                )
            }
        }
        seen.push({ round, hash, signature })
        if (seen.length > ROUNDS_PER_MEMBER) seen.shift()
        this.byMember.set(member, seen)
        for (const listener of [...this.listeners]) listener()
        return outcome
    }

    /** The precommits for `hash` in `round` at `height`, by member. */
    precommitsFor(
        height: number,
        round: number,
        hash: string,
    ): Record<string, string> {
        const out: Record<string, string> = {}
        if (this.height !== height) return out
        for (const [member, seen] of this.byMember) {
            const match = seen.find(p => p.round === round && p.hash === hash)
            if (match) out[member] = match.signature
        }
        return out
    }

    reset(): void {
        this.height = null
        this.byMember.clear()
    }
}

export const precommitBook = new PrecommitBook()

/**
 * Verify `incoming` as precommits for `hash` in `round` and record the
 * committee members' ones in the book. Returns the members recorded.
 */
export async function admitPrecommits(
    height: number,
    round: number,
    hash: string,
    incoming: unknown,
    committee: string[],
    book: PrecommitBook = precommitBook,
): Promise<string[]> {
    if (!isSignatureMap(incoming)) return []
    const signers = await verifiedPrecommitters(
        height,
        round,
        hash,
        incoming,
        committee,
    )
    for (const member of signers) {
        book.record(height, round, hash, member, incoming[member])
    }
    return [...signers]
}
