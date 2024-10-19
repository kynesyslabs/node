import { IWeb2Request } from "@kynesyslabs/demosdk/types"
import { DAHR } from "src/features/web2/dahr/DAHR"
import terminalKit from "terminal-kit"
const term = terminalKit.terminal

/**
 * DAHRFactory is a singleton class that manages DAHR instances.
 */
export class DAHRFactory {
    private static _instance: DAHRFactory
    private _dahrs: Map<string, { dahr: DAHR; lastAccess: number }> = new Map()
    private readonly _maxAge: number = 2 * 60 * 60 * 1000 // 2 hours

    /**
     * Private constructor to prevent direct object creation.
     */
    private constructor() {}

    /**
     * Clean up expired DAHR instances.
     */
    private _cleanupExpired(): void {
        const now = Date.now()
        let cleanedCount = 0
        for (const [sessionId, { lastAccess }] of this._dahrs) {
            if (now - lastAccess > this._maxAge) {
                this._dahrs.delete(sessionId)
                cleanedCount++
            }
        }
        if (cleanedCount > 0) {
            term.yellow(
                `[DAHRFactory] Cleaned up ${cleanedCount} expired DAHR instances\n`,
            )
        }
    }

    /**
     * Get the singleton instance of DAHRFactory.
     * @returns {DAHRFactory} The DAHRFactory instance.
     */
    static get instance(): DAHRFactory {
        if (!DAHRFactory._instance) {
            term.yellow("[DAHRFactory] Creating new DAHRFactory instance\n")
            DAHRFactory._instance = new DAHRFactory()
        }
        return DAHRFactory._instance
    }

    /**
     * Create a new DAHR instance.
     * @param {IWeb2Request} web2Request - The Web2 request to handle.
     * @returns {sessionId: string, dahr: DAHR} The sessionId and DAHR instance.
     */
    createDAHR(web2Request: IWeb2Request): { sessionId: string; dahr: DAHR } {
        this._cleanupExpired()
        const newDAHR = new DAHR(web2Request)
        const sessionId = newDAHR.sessionId // Get the sessionId from the DAHR instance
        term.yellow(
            `[DAHRManager] Creating new DAHR instance with sessionId: ${sessionId}\n`,
        )
        this._dahrs.set(sessionId, { dahr: newDAHR, lastAccess: Date.now() })

        return { sessionId, dahr: newDAHR }
    }

    /**
     * Get a DAHR instance by sessionId.
     * @param {string} sessionId - The session ID.
     * @returns {DAHR | undefined} The DAHR instance if found, undefined otherwise.
     */
    getDAHR(sessionId: string): DAHR | undefined {
        const dahrEntry = this._dahrs.get(sessionId)
        if (dahrEntry) {
            dahrEntry.lastAccess = Date.now() // Update last access time

            return dahrEntry.dahr
        }
        term.yellow(`[DAHRFactory] No DAHR found for sessionId: ${sessionId}\n`)

        return undefined
    }

    /**
     * Delete a DAHR instance by sessionId.
     * @param {string} sessionId - The session ID.
     */
    deleteDAHR(sessionId: string): void {
        if (this._dahrs.has(sessionId)) {
            this._dahrs.delete(sessionId)
            console.log(
                `DAHR with sessionId ${sessionId} removed successfully.`,
            )
        } else {
            console.log(`No DAHR found with sessionId ${sessionId}.`)
        }
    }

    /**
     * Get all DAHR instances.
     * @returns {Array<[string, DAHR]>} An array of [sessionId, DAHR] pairs.
     */
    getAllDAHRs(): Array<[string, DAHR]> {
        return Array.from(this._dahrs.entries()).map(
            ([sessionId, { dahr }]) => [sessionId, dahr],
        )
    }

    /**
     * Get all DAHR instances for a specific session.
     * @param {string} sessionId - The session ID.
     * @returns {Array<[string, DAHR]>} An array of [sessionId, DAHR] pairs.
     */
    getUserDAHRs(sessionId: string): Array<[string, DAHR]> {
        return Array.from(this._dahrs.entries())
            .filter(([_, { dahr }]) => dahr.sessionId === sessionId)
            .map(([sessionId, { dahr }]) => [sessionId, dahr])
    }
}
