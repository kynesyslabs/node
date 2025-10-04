/* eslint-disable no-unused-vars */
// INFO Entry point for multichain requests

import XMParser from "./routines/XMParser"
import { XMScript } from "@kynesyslabs/demosdk/types"

export default class MultichainDispatcher {
    // INFO Digesting the request from the server
    static async digest(data: XMScript) {
        console.log("\n\n")
        console.log("[XM Script full digest]")
        console.log(data)
        console.log("Stringed to:")
        console.log(JSON.stringify(data))
        console.log("\n\n")
        console.log("[XMChain Digestion] Processing multichain operation")
        console.log(data.operations)
        console.log("\n[XMChain Digestion] Having:")
        console.log(Object.keys(data.operations).length)
        console.log("operations")

        console.log("\n===== ANALYSIS ===== \n")
        console.log("\n===== FUNCTIONS ===== \n")
        for (let i = 0; i < Object.keys(data.operations).length; i++) {
            // Named function
            console.log(
                "[XMChain Digestion] Found: " + Object.keys(data.operations)[i],
            )
        }
        console.log("\n===== END OF ANALYSIS ===== \n")
        console.log("[XMChain Digestion] Proceeding: execution phase")
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
        console.log("[XM EXECUTE]: Script")
        console.log(JSON.stringify(script))
        const results = await XMParser.execute(script)
        console.log("[XM EXECUTE] Successfully executed")
        console.log(results)

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
