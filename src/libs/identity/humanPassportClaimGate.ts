import type { HumanPassportClaim } from "@/libs/identity/humanPassportClaim"
import {
    HUMAN_PASSPORT_EVM_ADDRESS_REGEX,
    HUMAN_PASSPORT_INVALID_ADDRESS_MESSAGE,
} from "@/libs/identity/tools/constants"

/**
 * getHumanPassportClaim is a public read that makes this node call the Human
 * Passport API (with this node's key and quota) every time. A wallet needs
 * one claim per link, so answers are reused for a short while per address,
 * and each caller may make only a few provider fetches a minute; fetching
 * one address for many callers costs a single call.
 */
export const CLAIM_CACHE_TTL_MS = 60_000
export const CLAIM_CACHE_MAX_ENTRIES = 4096
export const CLAIM_FETCH_BURST = 5
export const CLAIM_FETCHES_PER_SEC = 0.1
export const CLAIM_MAX_TRACKED_CALLERS = 4096

export interface ClaimGateOptions {
    now?: () => number
    ttlMs?: number
    maxEntries?: number
    burst?: number
    ratePerSec?: number
    maxCallers?: number
}

export type ClaimGateResult =
    | { claim: HumanPassportClaim }
    | { retryAfterMs: number }

interface Bucket {
    tokens: number
    updatedAt: number
}

export class HumanPassportClaimGate {
    // Map iteration order is insertion order: re-inserting on use makes the
    // first key the least recently used, which is the one dropped at the cap.
    private readonly cache = new Map<
        string,
        { claim: HumanPassportClaim; fetchedAt: number }
    >()
    private readonly inFlight = new Map<string, Promise<HumanPassportClaim>>()
    private readonly buckets = new Map<string, Bucket>()
    private readonly now: () => number
    private readonly ttlMs: number
    private readonly maxEntries: number
    private readonly burst: number
    private readonly ratePerSec: number
    private readonly maxCallers: number

    constructor(
        private readonly fetchClaim: (address: string) => Promise<HumanPassportClaim>,
        opts: ClaimGateOptions = {},
    ) {
        this.now = opts.now ?? Date.now
        this.ttlMs = opts.ttlMs ?? CLAIM_CACHE_TTL_MS
        this.maxEntries = opts.maxEntries ?? CLAIM_CACHE_MAX_ENTRIES
        this.burst = opts.burst ?? CLAIM_FETCH_BURST
        this.ratePerSec = opts.ratePerSec ?? CLAIM_FETCHES_PER_SEC
        this.maxCallers = opts.maxCallers ?? CLAIM_MAX_TRACKED_CALLERS
    }

    /**
     * The claim for `address`, from the cache when it is fresh. Only a
     * provider fetch is charged to `caller`; a failed fetch is not cached.
     * Callers without a verified key share one bucket (""). A malformed
     * address throws before any token is taken: the provider refuses it
     * without a request, so it must not use up the caller's fetches.
     */
    async get(caller: string, address: string): Promise<ClaimGateResult> {
        if (!HUMAN_PASSPORT_EVM_ADDRESS_REGEX.test(address)) {
            throw new Error(HUMAN_PASSPORT_INVALID_ADDRESS_MESSAGE)
        }
        const key = address.toLowerCase()
        const now = this.now()

        const cached = this.cache.get(key)
        if (cached && now - cached.fetchedAt < this.ttlMs) {
            this.cache.delete(key)
            this.cache.set(key, cached)
            return { claim: cached.claim }
        }
        if (cached) this.cache.delete(key)

        const pending = this.inFlight.get(key)
        if (pending) return { claim: await pending }

        const retryAfterMs = this.take(caller, now)
        if (retryAfterMs > 0) return { retryAfterMs }

        const fetching = this.fetchClaim(address)
        this.inFlight.set(key, fetching)
        try {
            const claim = await fetching
            this.cache.set(key, { claim, fetchedAt: this.now() })
            while (this.cache.size > this.maxEntries) {
                this.cache.delete(this.cache.keys().next().value as string)
            }
            return { claim }
        } finally {
            this.inFlight.delete(key)
        }
    }

    /** Addresses cached; for tests and diagnostics. */
    get cachedCount(): number {
        return this.cache.size
    }

    /** Callers tracked by the limiter; for tests and diagnostics. */
    get trackedCallers(): number {
        return this.buckets.size
    }

    /** 0 when the caller may fetch now, else the wait in ms. */
    private take(caller: string, now: number): number {
        const bucket = this.buckets.get(caller) ?? { tokens: this.burst, updatedAt: now }
        const elapsedSec = Math.max(0, now - bucket.updatedAt) / 1000
        bucket.tokens = Math.min(this.burst, bucket.tokens + elapsedSec * this.ratePerSec)
        bucket.updatedAt = now
        this.buckets.delete(caller)
        this.buckets.set(caller, bucket)
        // Dropping the least recently seen caller hands it a full bucket
        // later; the cap only keeps the table from growing with every key.
        while (this.buckets.size > this.maxCallers) {
            this.buckets.delete(this.buckets.keys().next().value as string)
        }
        if (bucket.tokens < 1) {
            return Math.ceil(((1 - bucket.tokens) / this.ratePerSec) * 1000)
        }
        bucket.tokens -= 1
        return 0
    }
}

let gate: HumanPassportClaimGate | null = null

/** The node's one gate, fetching through `fetchClaim` on a miss. */
export function humanPassportClaimGate(
    fetchClaim: (address: string) => Promise<HumanPassportClaim>,
): HumanPassportClaimGate {
    gate ??= new HumanPassportClaimGate(fetchClaim)
    return gate
}

/** Drops the node's gate; tests start each case from an empty one. */
export function resetHumanPassportClaimGate(): void {
    gate = null
}
