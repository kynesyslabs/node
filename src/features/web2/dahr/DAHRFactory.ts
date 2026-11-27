import { IWeb2Request } from "@kynesyslabs/demosdk/types"
import { skeletons } from "@kynesyslabs/demosdk/websdk"
import { DAHR } from "src/features/web2/dahr/DAHR"
import {
    SESSION_URL_MAX_CHARS,
    Web2SessionLimitError,
} from "src/features/web2/dahr/sessionLimit"
import type { Web2FetchCaller } from "src/features/web2/web2FetchLimiter"
import log from "src/utilities/logger"
import { Config } from "src/config"

// A session reads nothing from its create request but its action, method and
// URL, and only to echo them in the create reply: a start brings its own.
const NAME_MAX_CHARS = 32
const REFUSAL_LOG_INTERVAL_MS = 60_000

interface DAHREntry {
    dahr: DAHR
    lastAccess: number
    /** Caller key the session counts against; null when exempt or unknown. */
    owner: string | null
}

/**
 * The copy of a create request a session keeps: the SDK's empty request with
 * the caller's action, method and URL when they are short strings. Nothing
 * else in the create request is used later, and a start does not change the
 * copy.
 *
 * Of a start a session keeps only the normalized URL, in its relay, once the
 * start is admitted; the validator refuses one that is longer than
 * SESSION_URL_MAX_CHARS. So the request text a session holds stays within
 * these limits whatever its requests carried.
 */
function sessionRequest(request: IWeb2Request): IWeb2Request {
    const kept = structuredClone(skeletons.web2_request) as IWeb2Request
    const empty = kept.raw
    const raw = request?.raw
    kept.raw = {
        ...empty,
        action: short(raw?.action, NAME_MAX_CHARS, empty?.action),
        method: short(raw?.method, NAME_MAX_CHARS, empty?.method),
        url: short(raw?.url, SESSION_URL_MAX_CHARS, empty?.url),
    }
    return kept
}

function short<T>(value: unknown, maxChars: number, fallback: T): T {
    return (
        typeof value === "string" && value.length <= maxChars ? value : fallback
    ) as T
}

/**
 * DAHRFactory is a singleton class that manages DAHR instances.
 *
 * The sessions it holds are bounded: one caller holds at most
 * web2MaxSessionsPerCaller (a new one closes its least recently used), and
 * the node at most web2MaxSessionsTotal (a create beyond it is refused).
 */
export class DAHRFactory {
    private static _instance: DAHRFactory
    private _dahrs: Map<string, DAHREntry> = new Map()
    // Idle lifetime: each started session holds a listening relay until it expires.
    private readonly _maxAge: number =
        Config.getInstance().outbound.web2SessionTtlMs
    private readonly _maxPerCaller: number =
        Config.getInstance().outbound.web2MaxSessionsPerCaller
    private readonly _maxTotal: number =
        Config.getInstance().outbound.web2MaxSessionsTotal
    private _lastRefusalLogAt = Number.NEGATIVE_INFINITY

    /**
     * Private constructor to prevent direct object creation.
     */
    private async cleanupExpired(): Promise<void> {
        const now = Date.now()
        let cleanedCount = 0
        for (const [sessionId, { dahr, lastAccess }] of this._dahrs) {
            if (now - lastAccess > this._maxAge) {
                await dahr.stopProxy()
                this._dahrs.delete(sessionId)
                cleanedCount++
            }
        }
        if (cleanedCount > 0) {
            log.info(
                "DAHR",
                `[DAHRFactory] Cleaned up ${cleanedCount} expired DAHR instances`,
            )
        }
    }

    /**
     * Get the singleton instance of DAHRFactory.
     * @returns {DAHRFactory} The DAHRFactory instance.
     */
    static get instance(): DAHRFactory {
        if (!DAHRFactory._instance) {
            log.info("DAHR", "[DAHRFactory] Creating new DAHRFactory instance")
            DAHRFactory._instance = new DAHRFactory()
        }
        return DAHRFactory._instance
    }

    /**
     * Create a new DAHR instance.
     * @param {IWeb2Request} web2Request - The Web2 request to handle.
     * @param {Web2FetchCaller} caller - Who the session counts against.
     * @returns {DAHR} The DAHR instance.
     * @throws {Web2SessionLimitError} When the node holds its maximum.
     */
    async createDAHR(
        web2Request: IWeb2Request,
        caller?: Web2FetchCaller,
    ): Promise<DAHR> {
        await this.cleanupExpired()
        // Nothing awaits from here to the insert, so concurrent creates
        // cannot pass the caps together.
        const owner = caller && !caller.exempt ? caller.key : null
        if (owner !== null) this.makeRoomFor(owner)
        if (this._dahrs.size >= this._maxTotal) this.refuse()
        const newDAHR = new DAHR(sessionRequest(web2Request))
        const sessionId = newDAHR.sessionId // Get the sessionId from the DAHR instance
        log.info(
            "DAHR",
            `[DAHRManager] Creating new DAHR instance with sessionId: ${sessionId}`,
        )
        this._dahrs.set(sessionId, {
            dahr: newDAHR,
            lastAccess: Date.now(),
            owner,
        })

        return newDAHR
    }

    /**
     * Closes the caller's least recently used sessions until it has room for
     * one more, so a client that opens a session per request keeps working.
     */
    private makeRoomFor(owner: string): void {
        const own = [...this._dahrs].filter(([, e]) => e.owner === owner)
        if (own.length < this._maxPerCaller) return
        // A stable sort: equal access times keep creation order.
        own.sort(([, a], [, b]) => a.lastAccess - b.lastAccess)
        const excess = own.length - this._maxPerCaller + 1
        for (const [sessionId, { dahr }] of own.slice(0, excess)) {
            this._dahrs.delete(sessionId)
            void dahr.stopProxy()
        }
    }

    /** Refuses a create on a full node, saying when the next slot frees. */
    private refuse(): never {
        const now = Date.now()
        let oldest = now
        for (const { lastAccess } of this._dahrs.values()) {
            oldest = Math.min(oldest, lastAccess)
        }
        const retryAfterSeconds = Math.max(
            1,
            Math.ceil((oldest + this._maxAge - now) / 1000),
        )
        if (now - this._lastRefusalLogAt >= REFUSAL_LOG_INTERVAL_MS) {
            this._lastRefusalLogAt = now
            log.warning(
                `[DAHRFactory] Refusing web2 sessions: ${this._maxTotal} are ` +
                    "live (WEB2_MAX_SESSIONS_TOTAL)",
            )
        }
        throw new Web2SessionLimitError(this._maxTotal, retryAfterSeconds)
    }

    /**
     * Get a DAHR instance by sessionId.
     * @param {string} sessionId - The session ID.
     * @returns {DAHR | undefined} The DAHR instance if found, undefined otherwise.
     */
    getDAHR(sessionId: string): DAHR | undefined {
        const dahrEntry = this._dahrs.get(sessionId)
        if (dahrEntry && Date.now() - dahrEntry.lastAccess > this._maxAge) {
            // Expired sessions are otherwise only swept on the next create.
            this._dahrs.delete(sessionId)
            void dahrEntry.dahr.stopProxy()
            log.info("DAHR", "[DAHRFactory] DAHR session expired")
            return undefined
        }
        if (dahrEntry) {
            dahrEntry.lastAccess = Date.now() // Update last access time

            return dahrEntry.dahr
        }
        log.info(
            "DAHR",
            `[DAHRFactory] No DAHR found for sessionId: ${sessionId}`,
        )

        return undefined
    }
}
