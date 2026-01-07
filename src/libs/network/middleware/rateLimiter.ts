import fs from "fs"
import { Server } from "bun"
import log from "src/utilities/logger"
import { Middleware } from "../bunServer"
import { getSharedState } from "@/utilities/sharedState"

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

interface MethodLimitConfig {
    maxRequests: number
    windowMs: number
}

interface RateLimitConfig {
    enabled: boolean
    defaultLimit: MethodLimitConfig
    blockDurationMs: number
    whitelistedIPs: string[]
    methodLimits: Record<string, MethodLimitConfig>
    txPerBlock: number
}

export class RateLimiter {
    public ipRequests = new Map<string, RateLimitData>()
    public config: RateLimitConfig
    public cleanupInterval: Timer
    private static instance: RateLimiter
    private local_ips = ["127.0.0.1", "localhost"]

    constructor(config: RateLimitConfig) {
        this.config = config

        // Clean up expired entries every 15 minutes
        this.cleanupInterval = setInterval(() => {
            this.cleanup()
            this.dumpIPs()
        }, 15 * 60 * 1000)

        this.loadIPs()
    }

    private cleanup(): void {
        const now = Date.now()
        const expiredIPs: string[] = []

        for (const [ip, data] of this.ipRequests.entries()) {
            // Remove entries that are not blocked and haven't been accessed recently
            if (
                !data.blocked &&
                now - data.firstRequest > this.config.defaultLimit.windowMs * 2
            ) {
                expiredIPs.push(ip)
            }

            // Remove entries where block has expired
            else if (
                data.blocked &&
                data.blockExpiry &&
                now >= data.blockExpiry
            ) {
                expiredIPs.push(ip)
            }
        }

        expiredIPs.forEach(ip => this.ipRequests.delete(ip))

        if (expiredIPs.length > 0) {
            log.info(
                `[Rate Limiter] Cleaned up ${expiredIPs.length} expired IP entries`,
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
            await fs.promises.writeFile(
                filePath,
                JSON.stringify(allIPs),
            )
        } catch (error) {
            log.error(`[Rate Limiter] Failed to dump IPs: ${error}`)
        }
    }

    private loadIPs(): void {
        const filePath = "blocked_ips.json"

        try {
            const data: Record<string, RateLimitData> = JSON.parse(
                fs.readFileSync(filePath, "utf8"),
            )

            // load each IP and its RateLimitData to this.ipRequests
            for (const [ip, rateLimitData] of Object.entries(data)) {
                this.ipRequests.set(ip, rateLimitData)
            }

            log.info(
                `[Rate Limiter] Loaded ${
                    Object.keys(data).length
                } blocked IPs from ${filePath}`,
            )
        } catch (error: any) {
            log.warning(
                `[Rate Limiter] Failed to load blocked IPs from ${filePath}: ${error.message}`,
            )
        }
    }

    public getClientIP(req: Request, server: Server): string {
        const realIP = req.headers.get("x-real-ip")
        const forwardedFor = req.headers.get("x-forwarded-for")

        // INFO: Check for proxy headers first (common when behind reverse proxy)
        if (forwardedFor) {
            // INFO: x-forwarded-for can contain multiple IPs, take the first one
            const firstIP = forwardedFor.split(",")[0].trim()
            if (firstIP && !this.local_ips.includes(firstIP)) {
                return firstIP
            }
        }

        if (realIP && !this.local_ips.includes(realIP)) {
            return realIP
        }

        // INFO: Fallback to direct connection IP
        const ip = server.requestIP(req)
        if (ip?.address) {
            return ip.address
        }

        return "unknown"
    }

    private isTrustedProxy(ip: string): boolean {
        // Define trusted proxy IP ranges/addresses
        const trustedProxies = [
            // "127.0.0.1",
            // "::1",
            // Add your load balancer/proxy IPs here
            // "10.0.0.0/8",
            // "172.16.0.0/12",
            // "192.168.0.0/16",
            // Cloudflare IP ranges would go here in production
        ]

        return trustedProxies.includes(ip)
    }

    private extractForwardedIP(req: Request): string | null {
        // Try various headers in order of preference
        const xForwardedFor = req.headers.get("x-forwarded-for")
        const xRealIP = req.headers.get("x-real-ip")
        const cfConnectingIP = req.headers.get("cf-connecting-ip")

        if (xForwardedFor) {
            // X-Forwarded-For can contain multiple IPs, take the first one (leftmost = original client)
            const firstIP = xForwardedFor.split(",")[0].trim()
            if (this.isValidIP(firstIP)) {
                return firstIP
            }
        }

        if (xRealIP && this.isValidIP(xRealIP)) {
            return xRealIP
        }

        if (cfConnectingIP && this.isValidIP(cfConnectingIP)) {
            return cfConnectingIP
        }

        return null
    }

    private isValidIP(ip: string): boolean {
        // Basic IP validation (IPv4 and IPv6)
        const ipv4Regex =
            /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/
        const ipv6Regex =
            /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/

        return ipv4Regex.test(ip) || ipv6Regex.test(ip)
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

        return this.config.methodLimits[method] || this.config.defaultLimit
    }

    public createMiddleware(): Middleware {
        return async (req, next, server) => {
            if (!this.config.enabled) {
                return await next()
            }

            const clientIP = this.getClientIP(req, server)
            log.debug(`[Rate Limiter] Client IP: ${clientIP}`)

            // Skip rate limiting for whitelisted IPs
            if (this.config.whitelistedIPs.includes(clientIP)) {
                log.debug(
                    `[Rate Limiter] Whitelisted IP: ${clientIP}, skipping rate limiting`,
                )
                return await next()
            }

            const now = Date.now()
            const method = this.getMethodFromRequest(req)
            const limit = this.getLimitForMethod(method)

            const ipData = this.ipRequests.get(clientIP) || {
                count: 0,
                firstRequest: now,
                blocked: false,
                lastSeenBlockNumber: 0,
                lastSeenWithinBlockCount: 0,
            }

            const isBlocked =
                ipData.blocked && ipData.blockExpiry && now < ipData.blockExpiry
            const isBlockedByBlockCount =
                ipData.lastSeenWithinBlockCount >= this.config.txPerBlock

            // Check if IP is currently blocked
            if (isBlocked || isBlockedByBlockCount) {
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
                ipData.blocked = true
                ipData.blockExpiry = now + this.config.blockDurationMs

                log.warning(
                    `[Rate Limiter] IP ${clientIP} exceeded limit (${ipData.count}/${limit.maxRequests}) and blocked for ${this.config.blockDurationMs}ms`,
                )

                this.ipRequests.set(clientIP, ipData)

                return new Response(
                    JSON.stringify({
                        error: "Rate limit exceeded",
                        // limit: limit.maxRequests,
                        // windowMs: limit.windowMs,
                        retryAfter: Math.ceil(
                            this.config.blockDurationMs / 1000,
                        ),
                    }),
                    {
                        status: 429,
                        headers: {
                            "Content-Type": "application/json",
                            "Retry-After": Math.ceil(
                                this.config.blockDurationMs / 1000,
                            ).toString(),
                        },
                    },
                )
            }

            this.ipRequests.set(clientIP, ipData)

            // Log high usage (above 80% of limit)
            if (ipData.count > limit.maxRequests * 0.8) {
                log.warning(
                    `[Rate Limiter] High usage from IP ${clientIP}: ${ipData.count}/${limit.maxRequests}`,
                )
            }

            return await next()
        }
    }

    public getStats(): {
        totalIPs: number
        blockedIPs: number
        activeRequests: number
    } {
        const now = Date.now()
        let blockedIPs = 0
        let activeRequests = 0

        for (const [, data] of this.ipRequests.entries()) {
            if (data.blocked && data.blockExpiry && now < data.blockExpiry) {
                blockedIPs++
            }
            if (now - data.firstRequest < this.config.defaultLimit.windowMs) {
                activeRequests += data.count
            }
        }

        return {
            totalIPs: this.ipRequests.size,
            blockedIPs,
            activeRequests,
        }
    }

    public unblockIP(ips: string[]): Record<string, boolean> {
        const results = {}

        for (const ip of ips) {
            const ipData = this.ipRequests.get(ip)
            if (ipData && ipData.blocked) {
                ipData.blocked = false
                delete ipData.blockExpiry
                ipData.count = 0
                ipData.firstRequest = Date.now()
                this.ipRequests.set(ip, ipData)
                log.info(`[Rate Limiter] Manually unblocked IP ${ip}`)
                results[ip] = true
            } else {
                results[ip] = false
            }
        }

        return results
    }

    public destroy(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval)
        }
        this.ipRequests.clear()
    }

    static getInstance(): RateLimiter {
        if (!this.instance) {
            this.instance = new RateLimiter(getSharedState.rateLimitConfig)
        }

        return this.instance
    }
}
