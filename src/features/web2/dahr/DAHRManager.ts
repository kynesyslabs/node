import { IWeb2Request } from "@kynesyslabs/demosdk/types"

import { DAHR } from "src/features/web2/dahr/DAHR"

import terminalKit from "terminal-kit"

const term = terminalKit.terminal

/**
 * DAHRManager is a singleton class that manages DAHR instances.
 */
export class DAHRManager {
    /**
     * A static DAHRManager instance.
     * @type {DAHRManager}
     */
    private static _instance: DAHRManager
    
    /**
     * A map of DAHRs with DAHR name and DAHR instance.
     * @type {DAHRManager}
     */
    private static dahrs: Map<string, DAHR>

    /**
     * A static property used as a counter to generate unique session IDs.
     * @type {number}
     */
    private static progressive: 0
  
    /**
     * Private constructor to prevent direct object creation.
     */
    private constructor() {
        DAHRManager.dahrs = new Map()
    }
  
    /**
     * Get the singleton instance of DAHRManager.
     * @returns {DAHRManager} The singleton instance of DAHRManager.
     */
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
    getDAHR(sessionId: string = null, payload: IWeb2Request): DAHR {
        if (!sessionId) {
            sessionId = String(DAHRManager.progressive)
            DAHRManager.progressive += 1
        }

        if (!DAHRManager.dahrs.has(sessionId)) {
            term.yellow("[DAHRManager] Creating new DAHR instance\n")

            DAHRManager.dahrs.set(sessionId, new DAHR(payload))
        }

        return DAHRManager.dahrs.get(sessionId)
    }

    /**
     * Delete a DAHR instance by sessionId.
     * @param {string} sessionId - The session ID.
     */
    deleteDAHR(sessionId: string): void {
        if (DAHRManager.dahrs.has(sessionId)) {
            DAHRManager.dahrs.delete(sessionId)
            console.log(`Instance sessionId ${sessionId} removed successfully.`)
        } else {
            console.log(`No instance found with the name ${sessionId}.`)
        }
    }
  
    /**
     * Get all DAHR instances.
     * @returns {Array<[string, DAHR]>} An array of DAHR instances.
     */
    getAllDAHRs(): Array<[string, DAHR]> {
      return Array.from(DAHRManager.dahrs)
    }
  }