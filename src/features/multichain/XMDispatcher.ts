/* eslint-disable no-unused-vars */
// INFO Entry point for multichain requests

import XMParser from "./routines/XMParser"
import { XMScript } from "@kynesyslabs/demosdk/types"
import log from "@/utilities/logger"
import { featureDisabledMessage } from "src/libs/network/outboundSwitches"

export default class MultichainDispatcher {
    // INFO Digesting the request from the server
    static async digest(data: XMScript) {
        const disabled = featureDisabledMessage("xm")
        if (disabled) {
            return { success: false, message: disabled, results: {} }
        }
        let script: XMScript
        try {
            script = XMParser.prepare(data)
        } catch (e) {
            const reason = e instanceof Error ? e.message : String(e)
            return {
                success: false,
                message: `invalid_script: ${reason}`,
                results: {},
            }
        }
        // The script carries the caller's signed payloads: log its shape only.
        const names = Object.keys(script.operations)
        log.debug(
            `[XMChain Digestion] ${names.length} operation(s): ${names.join(", ")}`,
        )
        // REVIEW Execute
        return await MultichainDispatcher.execute(script)
    }

    // INFO Check syntax of xM Script
    static async load(script: string): Promise<any> {
        // TODO String to XMScript
        return await XMParser.load(script)
    }

    // INFO Executes a xM Script
    static async execute(script: XMScript) {
        const results = await XMParser.execute(script)

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
