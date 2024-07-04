import { IWeb2Request } from "@kynesyslabs/demosdk/types"

import { DAHR } from "src/features/web2/dahr/DAHR"

import terminalKit from "terminal-kit"

const term = terminalKit.terminal

/**
 * DAHRManager is a singleton class that manages DAHR instances.
 */
export class DAHRManager {
    private static _instance: DAHRManager
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
    getDAHR(sessionId: string, payload: IWeb2Request): DAHR {
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

    deleteDAHR(sessionId: string): void {
        if (DAHRManager.dahrs.has(sessionId)) {
            DAHRManager.dahrs.delete(sessionId)
            console.log(`Instance sessionId ${sessionId} removed successfully.`)
        } else {
            console.log(`No instance found with the name ${sessionId}.`)
        }
    }
  
    getAllDAHRs(): Array<[string, DAHR]> {
      return Array.from(DAHRManager.dahrs)
    }
  }