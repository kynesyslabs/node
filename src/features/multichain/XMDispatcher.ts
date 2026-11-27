/* eslint-disable no-unused-vars */
// INFO Entry point for multichain requests

import XMParser from "./routines/XMParser"
import { XMScript } from "@kynesyslabs/demosdk/types"
import log from "@/utilities/logger"
import { featureDisabledMessage } from "src/libs/network/outboundSwitches"
import { xmOpOutcome, xmScriptVerdict, type XmOpOutcome } from "./xmOutcome"

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
