import { IWeb2Request } from "@kynesyslabs/demosdk/types"
import { DAHR } from "src/features/web2/dahr/DAHR"
import log from "src/utilities/logger"
import { Config } from "src/config"

/**
 * DAHRFactory is a singleton class that manages DAHR instances.
 */
export class DAHRFactory {
    private static _instance: DAHRFactory
    private _dahrs: Map<string, { dahr: DAHR; lastAccess: number }> = new Map()
    // Idle lifetime: each started session holds a listening relay until it expires.
    private readonly _maxAge: number =
        Config.getInstance().outbound.web2SessionTtlMs

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
     * @returns {DAHR} The DAHR instance.
     */
    async createDAHR(web2Request: IWeb2Request): Promise<DAHR> {
        await this.cleanupExpired()
        const newDAHR = new DAHR(web2Request)
        const sessionId = newDAHR.sessionId // Get the sessionId from the DAHR instance
        log.info(
            "DAHR",
            `[DAHRManager] Creating new DAHR instance with sessionId: ${sessionId}`,
        )
        this._dahrs.set(sessionId, { dahr: newDAHR, lastAccess: Date.now() })

        return newDAHR
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
