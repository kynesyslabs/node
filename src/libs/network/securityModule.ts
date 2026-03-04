import { ISecurityReport } from "@kynesyslabs/demosdk/types"

export const modules = {
    // SECTION Modules
    // TODO Make some properties configurable
    communications: {
        response_registry: {
            flag_interval: 5000, // Milliseconds between responseRegistry pruning operations // Make it configurable
            flag_hardlimit: 10000, // Maximum number of milliseconds a response can exist
        },
        
    },
}

type RateBucket = { tokens: number; lastRefillMs: number }

const rateBuckets = new Map<string, RateBucket>()

function envInt(name: string, fallback: number): number {
    const raw = process.env[name]
    if (!raw) return fallback
    const v = Number.parseInt(raw, 10)
    return Number.isFinite(v) ? v : fallback
}

const SECURITY_RATE_LIMIT_ENABLED = process.env.SECURITY_RATE_LIMIT_ENABLED === "true"
const SECURITY_RATE_LIMIT_RPS = envInt("SECURITY_RATE_LIMIT_RPS", 25)
const SECURITY_RATE_LIMIT_BURST = envInt("SECURITY_RATE_LIMIT_BURST", 50)
const SECURITY_RATE_LIMIT_BUCKET_TTL_MS = envInt("SECURITY_RATE_LIMIT_BUCKET_TTL_MS", 10 * 60 * 1000)

function getBucketKey(sender: string, requestType: string): string {
    return `${sender}:${requestType}`
}

function refillBucket(bucket: RateBucket, nowMs: number): void {
    const elapsedMs = Math.max(0, nowMs - bucket.lastRefillMs)
    const refill = (elapsedMs / 1000) * SECURITY_RATE_LIMIT_RPS
    bucket.tokens = Math.min(SECURITY_RATE_LIMIT_BURST, bucket.tokens + refill)
    bucket.lastRefillMs = nowMs
}

export async function checkRateLimits(
    sender: string,
    requestType: string,
    reportedTimestamp = Date.now(),
): Promise<ISecurityReport> {
    if (!SECURITY_RATE_LIMIT_ENABLED) {
        return { code: "0", message: "rate_limit_disabled", state: true } as ISecurityReport
    }

    const nowMs = typeof reportedTimestamp === "number" ? reportedTimestamp : Date.now()
    const key = getBucketKey(String(sender ?? "unknown"), String(requestType ?? "unknown"))
    let bucket = rateBuckets.get(key)
    if (!bucket) {
        bucket = { tokens: SECURITY_RATE_LIMIT_BURST, lastRefillMs: nowMs }
        rateBuckets.set(key, bucket)
    }

    refillBucket(bucket, nowMs)
    const allowed = bucket.tokens >= 1
    if (allowed) bucket.tokens -= 1

    // Best-effort cleanup to avoid unbounded growth.
    if (rateBuckets.size > 10_000) {
        for (const [k, b] of rateBuckets) {
            if (nowMs - b.lastRefillMs > SECURITY_RATE_LIMIT_BUCKET_TTL_MS) rateBuckets.delete(k)
        }
    }

    return allowed
        ? ({ code: "0", message: "ok", state: true } as ISecurityReport)
        : ({ code: "RATE_LIMIT", message: "rate_limited", state: false } as ISecurityReport)
}
