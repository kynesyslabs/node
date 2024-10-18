import { IWeb2Request } from "@kynesyslabs/demosdk/types"
import { DAHR } from "src/features/web2/dahr/DAHR"
import terminalKit from "terminal-kit"

const term = terminalKit.terminal

/**
 * DAHRManager is a singleton class that manages DAHR instances.
 */
export class DAHRManager {
    private static _instance: DAHRManager
    private dahrs: Map<string, DAHR> = new Map()
    private idCounter = 0

    /**
     * Private constructor to prevent direct object creation.
     */
    private constructor() {}

    static get instance(): DAHRManager {
        if (!DAHRManager._instance) {
            term.yellow("[DAHRManager] Creating new DAHRManager instance\n")
            DAHRManager._instance = new DAHRManager()
        }
        return DAHRManager._instance
    }

    /**
     * Get a DAHR instance by sessionId. If it doesn't exist, create a new one.
     * @param {string} sessionId - The session ID.
     * @returns {DAHR} The DAHR instance.
     */
    getDAHR(sessionId: string, web2Request?: IWeb2Request): DAHR {
        if (!this.dahrs.has(sessionId)) {
            const id = (++this.idCounter).toString()
            term.yellow("[DAHRManager] DAHR not found, creating new instance\n")
            const newDAHR = new DAHR()
            if (web2Request) {
                newDAHR.web2Request = web2Request
            }
            this.dahrs.set(id, newDAHR)
            return newDAHR
        }

        return this.dahrs.get(sessionId)!
    }

    deleteDAHR(sessionId: string): void {
        if (this.dahrs.has(sessionId)) {
            this.dahrs.delete(sessionId)
            console.log(
                `DAHR with sessionId ${sessionId} removed successfully.`,
            )
        } else {
            console.log(`No DAHR found with sessionId ${sessionId}.`)
        }
    }

    getAllDAHRs(): Array<[string, DAHR]> {
        return Array.from(this.dahrs)
    }
}
