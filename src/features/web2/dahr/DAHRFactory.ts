import { IWeb2Request } from "@kynesyslabs/demosdk/types"
import { DAHR } from "src/features/web2/dahr/DAHR"
import log from "src/utilities/logger"
import { Config } from "src/config"
import type { Web2FetchCaller } from "src/features/web2/web2FetchLimiter"
import { DAHRSessionLimitError } from "src/features/web2/dahr/sessionLimitError"

interface SessionLimits {
    perCaller: number
    total: number
}

/**
 * DAHRFactory is a singleton class that manages DAHR instances.
 */
export class DAHRFactory {
    private static _instance: DAHRFactory
    private _dahrs: Map<
        string,
        { dahr: DAHR; lastAccess: number; owner: string | null }
    > = new Map()
    // Idle lifetime: each started session holds a listening relay until it expires.
    private readonly _maxAge: number =
        Config.getInstance().outbound.web2SessionTtlMs
    // Each session can hold a listening relay for its whole idle lifetime,
    // and creating one needs no signature or fee.
    private readonly _limits: SessionLimits = {
        perCaller: Config.getInstance().outbound.web2MaxSessionsPerCaller,
        total: Config.getInstance().outbound.web2MaxSessionsTotal,
    }

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
    static resetInstance(): void {
        DAHRFactory._instance = undefined
    }

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
     * @param caller - Who the session counts against; an exempt or absent
     * caller counts toward the node-wide cap only.
     * @returns {DAHR} The DAHR instance.
     * @throws {DAHRSessionLimitError} when a session cap is reached.
     */
    async createDAHR(
        web2Request: IWeb2Request,
        caller?: Web2FetchCaller,
    ): Promise<DAHR> {
        await this.cleanupExpired()
        const owner = caller && !caller.exempt ? caller.key : null
        this.assertRoomFor(owner)
        const newDAHR = new DAHR(web2Request)
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

    /** Open sessions in total, or held by `owner`. */
    sessionCount(owner?: string): number {
        if (owner === undefined) return this._dahrs.size
        let count = 0
        for (const entry of this._dahrs.values()) {
            if (entry.owner === owner) count++
        }
        return count
    }

    private assertRoomFor(owner: string | null): void {
        const { perCaller, total } = this._limits
        if (this._dahrs.size >= total) {
            throw new DAHRSessionLimitError(
                "node-sessions",
                `web2 session refused: this node holds its maximum of ${total} ` +
                    "open web2 sessions. Retry later.",
            )
        }
        if (owner !== null && this.sessionCount(owner) >= perCaller) {
            throw new DAHRSessionLimitError(
                "caller-sessions",
                `web2 session refused: this caller already holds ${perCaller} ` +
                    "open web2 sessions. Use one of them or wait for one to expire.",
            )
        }
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
