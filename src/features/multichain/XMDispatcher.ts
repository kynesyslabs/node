/* eslint-disable no-unused-vars */
// INFO Entry point for multichain requests

import XMParser from "./routines/XMParser"
import { XMScript } from "@kynesyslabs/demosdk/types"
import log from "@/utilities/logger"

export default class MultichainDispatcher {
    // INFO Digesting the request from the server
    static async digest(data: XMScript) {
        log.debug("\n\n")
        log.debug("[XM Script full digest]")
        log.debug(data)
        log.debug("Stringed to:")
        log.debug(JSON.stringify(data))
        log.debug("\n\n")
        log.debug("[XMChain Digestion] Processing multichain operation")
        log.debug(data.operations)
        log.debug("\n[XMChain Digestion] Having:")
        log.debug(Object.keys(data.operations).length)
        log.debug("operations")

        log.debug("\n===== ANALYSIS ===== \n")
        log.debug("\n===== FUNCTIONS ===== \n")
        for (let i = 0; i < Object.keys(data.operations).length; i++) {
            // Named function
            log.debug(
                "[XMChain Digestion] Found: " + Object.keys(data.operations)[i],
            )
        }
        log.debug("\n===== END OF ANALYSIS ===== \n")
        log.debug("[XMChain Digestion] Proceeding: execution phase")
        // REVIEW Execute
        return await MultichainDispatcher.execute(data)
    }

    // INFO Check syntax of xM Script
    static async load(script: string): Promise<any> {
        // TODO String to XMScript
        return await XMParser.load(script)
    }

    // INFO Executes a xM Script
    static async execute(script: XMScript) {
        log.debug("[XM EXECUTE]: Script")
        log.debug(JSON.stringify(script))
        const results = await XMParser.execute(script)
        log.debug("[XM EXECUTE] Successfully executed")
        log.debug("[XM EXECUTE] results: " + JSON.stringify(results))

        const totalOperations = Object.values(results).length
        const failedOperations = Object.values(results).filter(
            result => result.result === "error",
        ).length

        // INFO: If all operations failed, this demos tx won't be forged in the block
        if (failedOperations === totalOperations) {
            return {
                success: false,
                message: "all_ops_failed",
                results: results,
            }
        }

        return {
            success: true,
            message: failedOperations > 0 ? "partial_success" : "all_ops_ok",
            results: results,
        }
    }
}
