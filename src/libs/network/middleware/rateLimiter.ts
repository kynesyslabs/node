import fs from "fs"
import { Server } from "bun"
import ipaddr from "ipaddr.js"
import log from "src/utilities/logger"
import { Middleware } from "../bunServer"
import { getSharedState } from "@/utilities/sharedState"
import { isForkActive } from "@/forks"
import { getAuthContext, setAuthContext } from "../authContext"
import {
    verifySignature,
    isKeyWhitelisted,
    VerificationResult,
} from "../verifySignature"
import { PeerManager } from "@/libs/peer"
import { uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import {
    RATE_LIMIT_DEFAULT_BLOCK_DURATION_MS,
    RATE_LIMIT_MAX_TRACKED_COUNTERS,
} from "@/utilities/constants"

/** Separates the bucket name from the client IP in a counter key. */
const BUCKET_SEPARATOR = "|"
/** Bucket shared by every route that has no limit of its own. */
const DEFAULT_BUCKET = "default"

interface RateLimitData {
    count: number
    firstRequest: number
    blocked: boolean
    lastSeenBlockNumber: number
    lastSeenWithinBlockCount: number
    /**
     * The block expiry time in milliseconds
     */
    blockExpiry?: number
}

/**
 * What a client is counted as. An IPv6 customer is routinely handed a whole
 * /64, so counting each address separately would give one client as many
 * quotas as it has addresses; every address in a /64 shares one.
 */
function rateLimitSubject(ip: string): string {
    if (!ip.includes(":")) return ip
    try {
        const parsed = ipaddr.parse(ip)
        if (parsed.kind() !== "ipv6") return ip
        const v6 = parsed as ipaddr.IPv6
        if (v6.isIPv4MappedAddress()) return v6.toIPv4Address().toString()
        const network = ipaddr.IPv6.networkAddressFromCIDR(`${ip}/64`)
        return `${network.toRFC5952String()}/64`
    } catch {
        return ip
    }
}

/** Counter key: one per limit bucket per client subject. */
function bucketKey(bucket: string, ip: string): string {
    return `${bucket}${BUCKET_SEPARATOR}${rateLimitSubject(ip)}`
}

function splitBucketKey(key: string): { bucket: string; ip: string } | null {
    const at = key.indexOf(BUCKET_SEPARATOR)
    if (at <= 0) return null
    return { bucket: key.slice(0, at), ip: key.slice(at + 1) }
}

interface MethodLimitConfig {
    maxRequests: number
    windowMs: number
}

/**
 * Resolved CIDR entry for trusted-proxy matching. Built once at startup
 * from the `TRUSTED_PROXIES` env var via `parseTrustedProxies`.
 */
interface TrustedProxyCIDR {
    kind: "ipv4" | "ipv6"
    addr: ipaddr.IPv4 | ipaddr.IPv6
    bits: number
}

/**
 * XFF handling modes — see docs/discoveries/startup-assessment-2026-05-13/08-epic-3-blockers.md
 *  - "off":    ignore X-Forwarded-For / X-Real-IP / CF-Connecting-IP entirely,
 *              always use the socket peer address. Safe-by-default. Default
 *              when `TRUSTED_PROXIES` is empty.
 *  - "strict": honor proxy headers ONLY when the socket peer matches one of
 *              the CIDRs in `TRUSTED_PROXIES`. Parses XFF right-to-left and
 *              returns the left-most non-trusted address (RFC 7239 §5.2).
 *              Default when `TRUSTED_PROXIES` is non-empty.
 *  - "legacy": pre-fix behaviour — trust XFF/XRI from any source. Opt-in
 *              escape hatch (`XFF_MODE=legacy`), logged loudly at startup.
 */
type XffMode = "off" | "strict" | "legacy"

interface RateLimitConfig {
    enabled: boolean
    defaultLimit: MethodLimitConfig
    blockDurationMs: number
    whitelistedIPs: string[]
    whitelistedKeys: string[]
    methodLimits: Record<string, MethodLimitConfig>
    txPerBlock: number
    /** Optional — most counters kept at once; the oldest are dropped past it. */
    maxTrackedCounters?: number
    /**
     * Optional — when omitted (or empty string), resolved from env at
     * construct time. Accepts the literal modes plus arbitrary strings
     * (validated and falls back to "auto" on anything else) so callers
     * can hand through the raw loader value without narrowing.
     */
    xffMode?: XffMode | string
    /** Optional — when omitted, resolved from env at construct time. */
    trustedProxies?: string[]
}

/**
 * Parse a `TRUSTED_PROXIES` CSV string into resolved CIDR entries.
 *
 * Accepts plain addresses (treated as /32 for IPv4, /128 for IPv6) and
 * CIDR notation. Invalid entries are logged and skipped — startup never
 * throws over bad input, but the operator sees the error.
 */
function parseTrustedProxies(cidrs: string[]): TrustedProxyCIDR[] {
    const parsed: TrustedProxyCIDR[] = []
    for (const raw of cidrs) {
        const entry = raw.trim()
        if (!entry) continue
        try {
            let addr: ipaddr.IPv4 | ipaddr.IPv6
            let bits: number
            if (entry.includes("/")) {
                const [parsedAddr, parsedBits] = ipaddr.parseCIDR(entry)
                addr = parsedAddr
                bits = parsedBits
            } else {
                addr = ipaddr.parse(entry)
                bits = addr.kind() === "ipv4" ? 32 : 128
            }
            parsed.push({
                kind: addr.kind() === "ipv4" ? "ipv4" : "ipv6",
                addr,
                bits,
            })
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            log.error(
                `[Rate Limiter] Invalid TRUSTED_PROXIES entry "${entry}": ${msg}`,
            )
        }
    }
    return parsed
}

/**
 * Canonicalise an IP string before bucketing.
 *
 * Strips IPv6 brackets and trailing port (e.g. `[::1]:443` → `::1`,
 * `1.2.3.4:80` → `1.2.3.4`), then normalises with ipaddr.js so that
 * `192.168.1.1`, `::ffff:192.168.1.1`, and `[::ffff:192.168.1.1]:443`
 * all collapse to the same canonical form. Prevents the bucket-multiplier
 * attack where a single client multiplies its quota by varying the IP
 * representation in spoofed headers.
 *
 * Returns the canonical string, or the raw input if it cannot be parsed
 * (so unknown values still bucket consistently).
 */
function normalizeIP(raw: string): string {
    if (!raw) return raw
    let s = raw.trim()
    // Strip bracketed IPv6 with optional port: [::1]:443 → ::1
    if (s.startsWith("[")) {
        const end = s.indexOf("]")
        if (end > 0) {
            s = s.slice(1, end)
        }
    } else if (
        s.includes(".") &&
        s.lastIndexOf(":") > s.lastIndexOf(".")
    ) {
        // IPv4 with port like 1.2.3.4:80 — the colon comes AFTER the
        // last dot. Distinct from IPv4-mapped IPv6 (::ffff:1.2.3.4)
        // where dots come after the last colon.
        s = s.split(":")[0]
    }
    try {
        const parsed = ipaddr.parse(s)
        if (parsed.kind() === "ipv6") {
            const v6 = parsed as ipaddr.IPv6
            if (v6.isIPv4MappedAddress()) {
                return v6.toIPv4Address().toString()
            }
            // Use RFC 5952 canonical form (collapsed zeros) so `::1`,
            // `0:0:0:0:0:0:0:1`, and `::0001` all bucket together.
            return v6.toRFC5952String()
        }
        return parsed.toString()
    } catch {
        return s
    }
}

/**
 * Check whether an IP is inside any CIDR in the resolved trusted-proxy set.
 */
function isWithinTrusted(
    ip: string,
    trusted: TrustedProxyCIDR[],
): boolean {
    if (trusted.length === 0) return false
    let parsed: ipaddr.IPv4 | ipaddr.IPv6
    try {
        parsed = ipaddr.parse(ip)
    } catch {
        return false
    }
    const ipKind = parsed.kind()
    for (const entry of trusted) {
        if (entry.kind !== ipKind) continue
        try {
            if (parsed.match(entry.addr as never, entry.bits)) {
                return true
            }
        } catch {
            // mismatched address families inside ipaddr.match — skip
        }
    }
    return false
}

/**
 * Resolve the effective XFF mode for this process.
 *
 * Selection rules (see docs/discoveries/.../08-epic-3-blockers.md §T1):
 *  - `XFF_MODE=legacy` (explicit) → legacy + log.error at startup
 *  - `XFF_MODE=off` (explicit) → off (ignore any TRUSTED_PROXIES)
 *  - `XFF_MODE=strict` (explicit) → strict (even when list is empty,
 *    in which case all proxy headers will be rejected — useful as a
 *    "deny all proxies" stance for direct-internet deployments)
 *  - no override + TRUSTED_PROXIES non-empty → strict
 *  - no override + TRUSTED_PROXIES empty → off
 */
function resolveXffMode(
    explicit: XffMode | undefined,
    hasTrustedList: boolean,
): XffMode {
    if (explicit === "off" || explicit === "strict" || explicit === "legacy") {
        return explicit
    }
    return hasTrustedList ? "strict" : "off"
}

export class RateLimiter {
    public ipRequests = new Map<string, RateLimitData>()
    public config: RateLimitConfig
    public cleanupInterval: Timer
    private static instance: RateLimiter
    /**
     * Loopback addresses that bypass proxy-header handling. When a header
     * value is loopback we never trust it as a "real" client identifier;
     * we fall through to the socket peer (which itself is whitelisted by
     * `LOCALHOST_IPS` further down the pipeline if it's also loopback).
     */
    private local_ips = ["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]

    /** Resolved trusted-proxy CIDRs. Empty when no list configured. */
    private trustedProxies: TrustedProxyCIDR[]
    /** Final XFF mode after env + explicit-config resolution. */
    private xffMode: XffMode
    /**
     * Last time we emitted an XFF-rejection log line for a given socket IP.
     * Used to sample-rate the warning (max 1 / minute / source) so a hostile
     * client cannot flood logs. Cleared by `destroy()`.
     */
    private xffRejectLastLog = new Map<string, number>()

    constructor(config: RateLimitConfig) {
        this.config = config

        // Prefer the explicit config list (loader pre-parses TRUSTED_PROXIES
        // into core.trustedProxies). Fall back to reading the env var
        // directly so tests can stub the constructor without the full
        // loader pipeline.
        const fromConfig =
            config.trustedProxies && config.trustedProxies.length > 0
                ? config.trustedProxies
                : undefined
        const fromEnv = process.env.TRUSTED_PROXIES
            ? process.env.TRUSTED_PROXIES.split(",")
                  .map(s => s.trim())
                  .filter(s => s.length > 0)
            : []
        this.trustedProxies = parseTrustedProxies(fromConfig ?? fromEnv)

        // Config may pass "" to mean "auto" — coerce to undefined so the
        // env-var override is consulted next.
        const configMode =
            config.xffMode && config.xffMode.length > 0
                ? (config.xffMode as XffMode)
                : undefined
        const envOverride = process.env.XFF_MODE as XffMode | undefined
        this.xffMode = resolveXffMode(
            configMode ?? envOverride,
            this.trustedProxies.length > 0,
        )

        this.announceXffMode()

        // Clean up expired entries every 15 minutes
        this.cleanupInterval = setInterval(
            () => {
                this.cleanup()
                this.dumpIPs()
            },
            15 * 60 * 1000,
        )

        void this.loadIPs()
    }

    /**
     * Emit a single startup line documenting the active XFF mode + trust
     * list. Loud for legacy mode (the insecure option), informational for
     * strict, warning for off when no trust list is set.
     */
    private announceXffMode(): void {
        const count = this.trustedProxies.length
        if (this.xffMode === "legacy") {
            log.error(
                "[Rate Limiter] XFF_MODE=legacy — proxy headers trusted from " +
                    "ANY source. This is INSECURE; set TRUSTED_PROXIES or " +
                    "remove XFF_MODE=legacy to enable the safe default.",
            )
            return
        }
        if (this.xffMode === "strict") {
            log.info(
                `[Rate Limiter] XFF_MODE=strict — honoring proxy headers from ` +
                    `${count} trusted CIDR(s)`,
            )
            return
        }
        // off
        if (count > 0) {
            log.warning(
                "[Rate Limiter] XFF_MODE=off but TRUSTED_PROXIES is set — " +
                    "proxy headers will still be IGNORED (explicit off wins). " +
                    "Remove the override or set XFF_MODE=strict to honor them.",
            )
        } else {
            log.warning(
                "[Rate Limiter] XFF_MODE=off (no TRUSTED_PROXIES configured) — " +
                    "X-Forwarded-For / X-Real-IP / CF-Connecting-IP are ignored. " +
                    "Set TRUSTED_PROXIES to enable proxy-aware client IPs.",
            )
        }
    }

    /**
     * Sample-rate logger for XFF-rejection events. At most one log line
     * per source socket IP per minute.
     */
    private logXffRejection(socketIp: string, reason: string): void {
        const now = Date.now()
        const last = this.xffRejectLastLog.get(socketIp) ?? 0
        if (now - last < 60_000) return
        this.xffRejectLastLog.set(socketIp, now)
        log.warning(
            `[Rate Limiter] XFF rejected from ${socketIp}: ${reason}`,
        )
    }

    /**
     * How long an IP stays blocked. A missing or non-positive configured
     * value falls back to the default: a block that expires the moment it
     * is set, or never gets a valid expiry, would not block at all.
     */
    private blockDurationMs(): number {
        const configured = this.config.blockDurationMs
        return Number.isFinite(configured) && configured > 0
            ? configured
            : RATE_LIMIT_DEFAULT_BLOCK_DURATION_MS
    }

    /** Which counter a request method draws on. */
    private bucketFor(method: string | null): string {
        return method && this.config.methodLimits[method]
            ? method
            : DEFAULT_BUCKET
    }

    private getLimitForBucket(bucket: string): MethodLimitConfig {
        return bucket === DEFAULT_BUCKET
            ? this.config.defaultLimit
            : this.config.methodLimits[bucket] || this.config.defaultLimit
    }

    /** The counter a method keeps for an IP, if it has one. */
    public getEntry(method: string, ip: string): RateLimitData | undefined {
        return this.ipRequests.get(bucketKey(this.bucketFor(method), ip))
    }

    public setEntry(method: string, ip: string, data: RateLimitData): void {
        this.ipRequests.set(bucketKey(this.bucketFor(method), ip), data)
    }

    /**
     * Keeps the number of counters bounded when requests keep arriving from
     * new sources. Past the cap the counters with the oldest window start go,
     * live blocks last so a flood cannot wash its own block away. A tenth of
     * the cap is dropped at once so this does not run on every new source.
     */
    private makeRoomForCounter(now: number): void {
        const max = this.config.maxTrackedCounters ?? RATE_LIMIT_MAX_TRACKED_COUNTERS
        if (this.ipRequests.size < max) return

        const ranked = [...this.ipRequests.entries()].sort(([, a], [, b]) => {
            const aLive = a.blocked && a.blockExpiry > now ? 1 : 0
            const bLive = b.blocked && b.blockExpiry > now ? 1 : 0
            return aLive - bLive || a.firstRequest - b.firstRequest
        })
        const drop = Math.max(1, Math.floor(max / 10))
        for (const [key] of ranked.slice(0, drop)) {
            this.ipRequests.delete(key)
        }
        log.warning(
            `[Rate Limiter] ${max} counters tracked; dropped the ${drop} oldest`,
        )
    }

    /**
     * Drop counters that no longer hold anything: those whose block (if any)
     * has run out and whose OWN bucket's window has passed. A short-window
     * counter's age says nothing about a long-window one, so each entry is
     * judged against the window it was counted in.
     */
    private cleanup(): void {
        const now = Date.now()
        const expiredKeys: string[] = []

        for (const [key, data] of this.ipRequests.entries()) {
            const parts = splitBucketKey(key)
            if (!parts) {
                // Legacy blocked_ips.json keys have no bucket and cannot be mapped.
                expiredKeys.push(key)
                continue
            }

            // A live block is kept whatever the window says.
            if (data.blocked && data.blockExpiry > now) {
                continue
            }

            // Past its block the entry still carries the count of its
            // window, which is what holds a long-window cap.
            const { windowMs } = this.getLimitForBucket(parts.bucket)
            if (now - data.firstRequest > windowMs) {
                expiredKeys.push(key)
            }
        }

        expiredKeys.forEach(key => this.ipRequests.delete(key))

        if (expiredKeys.length > 0) {
            log.info(
                `[Rate Limiter] Cleaned up ${expiredKeys.length} expired counters`,
            )
        }
    }

    private async dumpIPs(): Promise<void> {
        const filePath = "blocked_ips.json"
        // get all RateLimitData for all IPs as an object of IP: RateLimitData
        const allIPs: Record<string, RateLimitData> = {}
        for (const [ip, data] of this.ipRequests.entries()) {
            allIPs[ip] = data
        }
        try {
            await fs.promises.writeFile(filePath, JSON.stringify(allIPs))
        } catch (error) {
            log.error(`[Rate Limiter] Failed to dump IPs: ${error}`)
        }
    }

    private async loadIPs(): Promise<void> {
        const filePath = "blocked_ips.json"

        try {
            const data: Record<string, RateLimitData> = JSON.parse(
                await fs.promises.readFile(filePath, "utf8"),
            )

            // load each IP and its RateLimitData to this.ipRequests
            for (const [key, rateLimitData] of Object.entries(data)) {
                // Legacy blocked_ips.json keys have no bucket and cannot be mapped.
                if (!splitBucketKey(key)) continue
                this.ipRequests.set(key, rateLimitData)
            }

            log.info(
                `[Rate Limiter] Loaded ${
                    Object.keys(data).length
                } blocked IPs from ${filePath}`,
            )
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error)
            log.warning(
                `[Rate Limiter] Failed to load blocked IPs from ${filePath}: ${errorMsg}`,
            )
        }
    }

    /**
     * Resolve the client IP for rate-limit bucketing.
     *
     * Behaviour depends on `this.xffMode`:
     *  - "off":    use the socket peer address; proxy headers ignored.
     *  - "strict": honor X-Forwarded-For / X-Real-IP / CF-Connecting-IP iff
     *              the socket peer matches a CIDR in TRUSTED_PROXIES. Parses
     *              XFF right-to-left so a chain of trusted hops collapses to
     *              the left-most non-trusted address (the real client).
     *              Rejected headers fall back to the socket peer and emit a
     *              sample-rated warning.
     *  - "legacy": pre-fix behaviour (XFF / XRI trusted unconditionally).
     *              Insecure; opt-in only.
     *
     * Returned address is normalised via `normalizeIP` so that representation
     * variants (mapped IPv6, bracketed forms, embedded ports) collapse to a
     * single bucket key.
     */
    public getClientIP(req: Request, server: Server): string {
        const socketAddr = server.requestIP(req)?.address ?? ""
        const socketIp = socketAddr ? normalizeIP(socketAddr) : "unknown"

        if (this.xffMode === "off") {
            return socketIp
        }

        const forwardedFor = req.headers.get("x-forwarded-for")
        const realIp = req.headers.get("x-real-ip")
        const cfIp = req.headers.get("cf-connecting-ip")

        if (this.xffMode === "legacy") {
            if (forwardedFor) {
                const firstIp = forwardedFor.split(",")[0].trim()
                if (firstIp && !this.local_ips.includes(firstIp)) {
                    return normalizeIP(firstIp)
                }
            }
            if (realIp && !this.local_ips.includes(realIp)) {
                return normalizeIP(realIp)
            }
            return socketIp
        }

        // strict mode
        if (!socketAddr) {
            // No socket peer means we cannot verify the upstream — refuse
            // to honor proxy headers, treat as anonymous.
            return socketIp
        }
        if (!isWithinTrusted(socketIp, this.trustedProxies)) {
            if (forwardedFor || realIp || cfIp) {
                this.logXffRejection(
                    socketIp,
                    "untrusted remote sent proxy headers",
                )
            }
            return socketIp
        }

        // Socket is trusted — walk XFF right-to-left, returning the
        // left-most address that is NOT itself a trusted hop. Falls back
        // to X-Real-IP, then CF-Connecting-IP, then socket.
        if (forwardedFor) {
            const chain = forwardedFor
                .split(",")
                .map(s => s.trim())
                .filter(s => s.length > 0)
            for (let i = chain.length - 1; i >= 0; i--) {
                const candidate = normalizeIP(chain[i])
                if (!isWithinTrusted(candidate, this.trustedProxies)) {
                    return candidate
                }
            }
        }
        if (realIp) {
            return normalizeIP(realIp)
        }
        if (cfIp) {
            return normalizeIP(cfIp)
        }
        return socketIp
    }

    public isTrustedInternalRequest(req: Request, clientIP?: string): boolean {
        if (
            clientIP &&
            this.config.whitelistedIPs.includes(clientIP)
        ) {
            return true
        }

        const authCtx = getAuthContext(req)
        if (!authCtx.verified || !authCtx.publicKey) {
            return false
        }

        const localNodePublicKey = getSharedState.keypair?.publicKey
            ? uint8ArrayToHex(
                  getSharedState.keypair.publicKey as Uint8Array,
              )
            : null

        if (
            localNodePublicKey &&
            authCtx.publicKey === localNodePublicKey
        ) {
            return true
        }

        return !!PeerManager.getInstance().getPeer(authCtx.publicKey)
    }

    private getMethodFromRequest(req: Request): string | null {
        try {
            // For GET requests, we can infer the method from the URL path
            const url = new URL(req.url)
            const path = url.pathname

            // Map URL paths to method names for rate limiting
            const pathMethodMap: Record<string, string> = {
                "/info": "info",
                "/version": "version",
                "/publickey": "publickey",
                "/connectionstring": "connectionstring",
                "/peerlist": "peerlist",
                "/public_logs": "public_logs",
                "/diagnostics": "diagnostics",
                "/genesis": "genesis",
                "/genesisBlock": "genesisblock",
                "/identities": "identities",
            }

            if (req.method === "GET" && pathMethodMap[path]) {
                return pathMethodMap[path]
            }

            // For POST requests to root, we can't easily peek at the body
            // without consuming it, so we'll use default limits
            return "POST"
        } catch {
            return "POST"
        }
    }

    private getLimitForMethod(method: string | null): MethodLimitConfig {
        if (!method) {
            return this.config.defaultLimit
        }

        return this.getLimitForBucket(this.bucketFor(method))
    }

    public createMiddleware(): Middleware {
        return async (req, next, server) => {
            if (!this.config.enabled) {
                return await next()
            }

            // Skip rate limiting for infra/probe endpoints. LB and k8s
            // liveness/readiness probes hit /health frequently from a single
            // source IP and should never be 429-throttled. /version is small
            // and equally cheap to serve unconditionally.
            const path = new URL(req.url).pathname
            if (
                path === "/health" ||
                path === "/health/subsystems" ||
                path === "/version"
            ) {
                return await next()
            }

            // Check for identity/signature headers for key-based whitelisting
            const identity = req.headers.get("identity")
            const signature = req.headers.get("signature")
            const timestamp = req.headers.get("timestamp")
            let verifyResult: VerificationResult | null = null

            if (identity && signature) {
                // AUDIT C3b — once nonceEnforcement is active, require the
                // timestamp-bound auth signature (kills the static replayable
                // token). Pre-fork keeps the legacy bare-pubkey verification so
                // re-sync / old chains stay byte-identical.
                const requireTimestampBinding = isForkActive(
                    "nonceEnforcement",
                    getSharedState.lastBlockNumber ?? 0,
                )
                verifyResult = await verifySignature(
                    identity,
                    signature,
                    timestamp,
                    requireTimestampBinding,
                )

                if (!verifyResult.valid) {
                    // Invalid signature - return 401
                    log.error(
                        `[Rate Limiter] Invalid signature: ${verifyResult.error}`,
                    )
                    return new Response(
                        JSON.stringify({
                            error: "Invalid signature",
                            details: verifyResult.error,
                        }),
                        {
                            status: 401,
                            headers: { "Content-Type": "application/json" },
                        },
                    )
                }

                // Attach verified auth context to request for handler to use
                setAuthContext(req, {
                    verified: true,
                    identity: verifyResult.identity,
                    publicKey: verifyResult.publicKey,
                    algorithm: verifyResult.algorithm,
                })
            }

            // Check if key is whitelisted
            if (
                verifyResult &&
                verifyResult.publicKey &&
                isKeyWhitelisted(
                    verifyResult.publicKey,
                    this.config.whitelistedKeys,
                )
            ) {
                log.info(
                    `[Rate Limiter] Whitelisted key: ${verifyResult.publicKey}, bypassing rate limiting`,
                )
                return await next()
            }

            const clientIP = this.getClientIP(req, server)

            // Skip rate limiting for whitelisted IPs
            if (this.isTrustedInternalRequest(req, clientIP)) {
                return await next()
            }

            const now = Date.now()
            const method = this.getMethodFromRequest(req)
            const limit = this.getLimitForMethod(method)

            const counterKey = bucketKey(this.bucketFor(method), clientIP)
            if (!this.ipRequests.has(counterKey)) {
                this.makeRoomForCounter(now)
            }
            const ipData = this.ipRequests.get(counterKey) || {
                count: 0,
                firstRequest: now,
                blocked: false,
                lastSeenBlockNumber: 0,
                lastSeenWithinBlockCount: 0,
            }

            // The block ending does not forgive the count: a long-window cap
            // (the daily POST quota) must hold through the block, and the
            // window reset below is what clears it once the window is over.
            if (ipData.blocked && !(ipData.blockExpiry > now)) {
                ipData.blocked = false
                delete ipData.blockExpiry
            }

            const isBlocked = ipData.blocked

            // Check if IP is currently blocked
            if (isBlocked) {
                const remainingTime = Math.ceil(
                    (ipData.blockExpiry - now) / 1000,
                )
                log.warning(
                    `[Rate Limiter] Blocked request from IP ${clientIP}, ${remainingTime}s remaining`,
                )

                return new Response(
                    JSON.stringify({
                        error: "IP blocked due to rate limiting",
                        retryAfter: remainingTime,
                    }),
                    {
                        status: 429,
                        headers: {
                            "Content-Type": "application/json",
                            "Retry-After": remainingTime.toString(),
                        },
                    },
                )
            }

            // Reset window if expired
            if (now - ipData.firstRequest > limit.windowMs) {
                ipData.count = 0
                ipData.firstRequest = now
                ipData.blocked = false
                delete ipData.blockExpiry
            }

            ipData.count++

            // Block if limit exceeded
            if (ipData.count > limit.maxRequests) {
                const blockMs = this.blockDurationMs()
                ipData.blocked = true
                ipData.blockExpiry = now + blockMs

                log.warning(
                    `[Rate Limiter] IP ${clientIP} exceeded limit (${ipData.count}/${limit.maxRequests}) and blocked for ${blockMs}ms`,
                )

                this.ipRequests.set(counterKey, ipData)

                return new Response(
                    JSON.stringify({
                        error: "Rate limit exceeded",
                        // limit: limit.maxRequests,
                        // windowMs: limit.windowMs,
                        retryAfter: Math.ceil(blockMs / 1000),
                    }),
                    {
                        status: 429,
                        headers: {
                            "Content-Type": "application/json",
                            "Retry-After": Math.ceil(blockMs / 1000).toString(),
                        },
                    },
                )
            }

            this.ipRequests.set(counterKey, ipData)

            // Log high usage (above 80% of limit)
            if (ipData.count > limit.maxRequests * 0.8) {
                log.warning(
                    `[Rate Limiter] High usage from IP ${clientIP}: ${ipData.count}/${limit.maxRequests}`,
                )
            }

            return await next()
        }
    }

    /**
     * Return the current rate-limit window state for a given IP. Used by
     * server_rpc to surface `X-RateLimit-{Limit,Remaining,Reset}` headers
     * on POST `/` responses so SDK clients can self-throttle.
     *
     * Returns null when the IP has no active window yet (no requests seen).
     */
    public getCurrentLimits(ip: string): {
        limit: number
        remaining: number
        resetEpochSeconds: number
    } | null {
        const ipData = this.getEntry("POST", ip)
        if (!ipData) {
            return null
        }

        // Match middleware: POST `/` resolves to the "POST" method bucket,
        // falling back to defaultLimit when not configured explicitly.
        const limitConfig = this.getLimitForMethod("POST")
        const limit = limitConfig.maxRequests
        const remaining = Math.max(0, limit - ipData.count)
        const resetEpochSeconds = Math.floor(
            (ipData.firstRequest + limitConfig.windowMs) / 1000,
        )

        return { limit, remaining, resetEpochSeconds }
    }

    public getStats(): {
        totalIPs: number
        blockedIPs: number
        activeRequests: number
    } {
        const now = Date.now()
        const allIPs = new Set<string>()
        const blocked = new Set<string>()
        let activeRequests = 0

        for (const [key, data] of this.ipRequests.entries()) {
            const parts = splitBucketKey(key)
            if (!parts) continue
            allIPs.add(parts.ip)
            if (data.blocked && data.blockExpiry && now < data.blockExpiry) {
                blocked.add(parts.ip)
            }
            const { windowMs } = this.getLimitForBucket(parts.bucket)
            if (now - data.firstRequest < windowMs) {
                activeRequests += data.count
            }
        }

        return {
            totalIPs: allIPs.size,
            blockedIPs: blocked.size,
            activeRequests,
        }
    }

    /** Lifts the block on every counter the IP has, across all buckets. */
    public unblockIP(ips: string[]): Record<string, boolean> {
        const results: Record<string, boolean> = {}
        const bySubject = new Map<string, string[]>()
        for (const ip of ips) {
            results[ip] = false
            const subject = rateLimitSubject(ip)
            bySubject.set(subject, [...(bySubject.get(subject) ?? []), ip])
        }

        for (const [key, ipData] of this.ipRequests.entries()) {
            const parts = splitBucketKey(key)
            const asked = parts ? bySubject.get(parts.ip) : undefined
            if (!asked || !ipData.blocked) continue
            ipData.blocked = false
            delete ipData.blockExpiry
            ipData.count = 0
            ipData.firstRequest = Date.now()
            for (const ip of asked) results[ip] = true
        }

        for (const ip of ips) {
            if (results[ip]) {
                log.info(`[Rate Limiter] Manually unblocked IP ${ip}`)
            }
        }

        return results
    }

    public destroy(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval)
        }
        this.ipRequests.clear()
        this.xffRejectLastLog.clear()
    }

    /** Exposed for tests / diagnostics — read-only view of resolved mode. */
    public getXffMode(): XffMode {
        return this.xffMode
    }

    /** Exposed for tests / diagnostics — number of resolved trusted CIDRs. */
    public getTrustedProxyCount(): number {
        return this.trustedProxies.length
    }

    static getInstance(): RateLimiter {
        if (!this.instance) {
            this.instance = new RateLimiter(getSharedState.rateLimitConfig)
        }

        return this.instance
    }
}
