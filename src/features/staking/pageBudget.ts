// Pure helpers for the staking page routes: the hourly relay budget, the
// Solana methods the relay accepts, and the config block injected into the page.

/** The only Solana JSON-RPC methods the page needs; everything else is refused. */
export const RELAYED_SOLANA_METHODS = new Set([
    "getTokenAccountsByOwner",
    "getLatestBlockhash",
    "getSignatureStatuses",
    "getBlockHeight",
])

/** Solana reads the page may relay through the node per hour, all clients together. */
export const STAKING_PAGE_RPC_PER_HOUR = 200

/** Largest relay request body accepted, in bytes. */
export const MAX_RELAY_BODY_BYTES = 4096

/** Largest proof submission body accepted, in bytes. */
export const MAX_SUBMIT_BODY_BYTES = 8192

export type RelayCheck = { ok: true; method: string } | { ok: false; reason: string }

/** Whether a parsed relay body is one JSON-RPC call to an allowed method. */
export function checkRelayRequest(body: unknown): RelayCheck {
    if (Array.isArray(body)) return { ok: false, reason: "batch requests are not relayed" }
    if (!body || typeof body !== "object") return { ok: false, reason: "body must be a JSON-RPC object" }
    const { jsonrpc, method } = body as { jsonrpc?: unknown; method?: unknown }
    if (jsonrpc !== "2.0") return { ok: false, reason: "jsonrpc must be \"2.0\"" }
    if (typeof method !== "string") return { ok: false, reason: "method must be a string" }
    if (!RELAYED_SOLANA_METHODS.has(method)) return { ok: false, reason: `method ${method} is not relayed` }
    return { ok: true, method }
}

/**
 * A fixed one-hour window shared by every caller. `take` spends one unit
 * and says how long until the window resets when none is left.
 */
export class HourlyBudget {
    private windowStart = Number.NEGATIVE_INFINITY
    private used = 0

    constructor(
        private readonly perHour: number,
        private readonly now: () => number = Date.now,
        private readonly windowMs = 3_600_000,
    ) {}

    take(): { ok: true; remaining: number } | { ok: false; retryAfterSeconds: number } {
        const at = this.now()
        if (at - this.windowStart >= this.windowMs) {
            this.windowStart = at
            this.used = 0
        }
        if (this.used >= this.perHour) {
            const retryAfterSeconds = Math.max(1, Math.ceil((this.windowStart + this.windowMs - at) / 1000))
            return { ok: false, retryAfterSeconds }
        }
        this.used += 1
        return { ok: true, remaining: this.perHour - this.used }
    }
}

export interface PageConfig {
    demosAddress: string
    rpcUrl: string
    submitUrl: string
}

/** Puts the node's config into the page as a JSON script block the page reads at load. */
export function injectPageConfig(html: string, config: PageConfig): string {
    const json = JSON.stringify(config).replace(/</g, "\\u003c")
    const block = `<script id="node-config" type="application/json">${json}</script>`
    const at = html.indexOf("</head>")
    if (at === -1) return `${block}${html}`
    return `${html.slice(0, at)}${block}\n${html.slice(at)}`
}
