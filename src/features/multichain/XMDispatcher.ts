/* eslint-disable no-unused-vars */
// INFO Entry point for multichain requests

import XMParser from "./routines/XMParser"
import { logEntries, logField } from "./routines/errorKind"
import { XMScript } from "@kynesyslabs/demosdk/types"
import log from "@/utilities/logger"
import { featureDisabledMessage } from "src/libs/network/outboundSwitches"
import { xmOpOutcome, xmScriptVerdict, type XmOpOutcome } from "./xmOutcome"

// digest refuses a script over this bound before any operation runs.
export { MAX_XM_OPERATIONS } from "src/utilities/constants"

type XmResults = Awaited<ReturnType<typeof XMParser.execute>>

export default class MultichainDispatcher {
    // INFO Digesting the request from the server
    static async digest(data: XMScript) {
        const disabled = featureDisabledMessage("xm")
        if (disabled) {
            return { success: false, message: disabled, results: {} as XmResults }
        }
        let script: XMScript
        try {
            script = XMParser.prepare(data)
        } catch (e) {
            return {
                success: false,
                message: e instanceof Error ? e.message : String(e),
                results: {} as XmResults,
            }
        }
        // NOTE Only operation types, chains and counts are logged: a script
        // carries signed transactions and call arguments
        log.debug(
            "[XMChain Digestion] Processing " +
                logEntries(
                    script.operations,
                    "operation(s)",
                    op =>
                        `${logField(op?.task?.type)} on ${logField(op?.chain)}.${logField(op?.subchain)}`,
                ),
        )
        return await MultichainDispatcher.execute(script)
    }

    // INFO Check syntax of xM Script
    static async load(script: string): Promise<any> {
        // TODO String to XMScript
        return await XMParser.load(script)
    }

    /**
     * Runs every operation and admits the Demos tx unless every one of them
     * failed. Operations go to independent chains one after another, so the
     * script cannot be atomic: when one fails, the ones before it may already
     * be final on their chains and nothing here can undo them. The Demos tx
     * is then the only record of what was sent, so a partial run is admitted
     * with its verdict, and each operation's outcome (and hash, when one was
     * sent) travels in the reply.
     */
    static async execute(script: XMScript) {
        const results = await XMParser.execute(script)
        // NOTE Keep this: it refuses results that cannot be serialised before admission
        const resultsSize = JSON.stringify(results).length
        log.debug(`[XM EXECUTE] results serialised, ${resultsSize} chars`)

        const outcomes: Record<string, XmOpOutcome> = {}
        for (const [name, reply] of Object.entries(results)) {
            outcomes[name] = xmOpOutcome(
                script.operations[name]?.task?.type,
                reply,
            )
        }
        const message = xmScriptVerdict(Object.values(outcomes))
        return {
            success: message !== "all_ops_failed",
            message,
            results,
            outcomes,
        }
    }
}
