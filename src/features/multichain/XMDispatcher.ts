/* eslint-disable no-unused-vars */
// INFO Entry point for multichain requests

import XMParser from "./routines/XMParser"
import { logEntries, logField } from "./routines/errorKind"
import { XMScript } from "@kynesyslabs/demosdk/types"
import log from "@/utilities/logger"
import { featureDisabledMessage } from "src/libs/network/outboundSwitches"

/**
 * Most operations one XM script may carry. digest refuses a script with
 * more, or whose operations are not an ordinary object (prototype
 * Object.prototype or null), before any of them runs.
 */
export const MAX_XM_OPERATIONS = 32

export default class MultichainDispatcher {
    // INFO Digesting the request from the server
    static async digest(data: XMScript) {
        const disabled = featureDisabledMessage("xm")
        if (disabled) {
            return { success: false, message: disabled, results: {} }
        }
        const operations: unknown = data?.operations
        if (
            typeof operations !== "object" ||
            operations === null ||
            Array.isArray(operations) ||
            (Object.getPrototypeOf(operations) !== Object.prototype &&
                Object.getPrototypeOf(operations) !== null) ||
            Object.keys(operations).length > MAX_XM_OPERATIONS
        ) {
            return {
                success: false,
                message: `XM script refused: operations must be an object of at most ${MAX_XM_OPERATIONS} entries`,
                results: {},
            }
        }
        // NOTE Only operation types, chains and counts are logged: a script
        // carries signed transactions and call arguments
        log.debug(
            "[XMChain Digestion] Processing " +
                logEntries(
                    data.operations,
                    "operation(s)",
                    op =>
                        `${logField(op?.task?.type)} on ${logField(op?.chain)}.${logField(op?.subchain)}`,
                ),
        )
        return await MultichainDispatcher.execute(data)
    }

    // INFO Check syntax of xM Script
    static async load(script: string): Promise<any> {
        // TODO String to XMScript
        return await XMParser.load(script)
    }

    // INFO Executes a xM Script
    static async execute(script: XMScript) {
        const results = await XMParser.execute(script)
        // NOTE Keep this: it refuses results that cannot be serialised before admission
        const resultsSize = JSON.stringify(results).length
        log.debug(`[XM EXECUTE] results serialised, ${resultsSize} chars`)

        const totalOperations = Object.values(results).length
        const failedOperations = Object.values(results).filter(
            result => result.result === "error",
        ).length
        log.debug(
            `[XM EXECUTE] ${failedOperations} of ${totalOperations} operation(s) failed`,
        )

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
