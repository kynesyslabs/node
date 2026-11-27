// INFO In this module is offloaded the parsing of XM requests
import * as fs from "fs"
import * as multichain from "@kynesyslabs/demosdk/xm-localsdk"
import { IOperation, XMScript } from "@kynesyslabs/demosdk/types"
import { chainIds } from "sdk/localsdk/multichain/configs/chainIds"
import log from "@/utilities/logger"

import handlePayOperation from "./executors/pay"
import handleContractRead from "./executors/contract_read"
import handleContractWrite from "./executors/contract_write"
import handleBalanceQuery from "./executors/balance_query"
import { xmScriptRefusal } from "../xmScriptShape"

// NOTE We define multichain into global so that we can use it later
global.multichain = multichain

// NOTE: We receive the operations as:
/*
multichain_operation: {
    name: IOperation,
    name: IOperation,
    ...
}
*/

/**
 * JSON.stringify data with bigints converted to strings
 */
function stringify(data: any) {
    return JSON.stringify(data, (_, v) =>
        typeof v === "bigint" ? v.toString() : v,
    )
}

class XMParser {
    // INFO Same as below but with file support
    static async loadFile(path: string): Promise<XMScript> {
        if (!fs.existsSync(path)) {
            log.debug("The file does not exist.")
            return null
        }
        if (path.includes("..")) {
            throw new Error("Invalid file path")
        }
        const script = fs.readFileSync(path, "utf8")
        return await XMParser.load(script)
    }

    // INFO Transforming a string in a XMScript
    static async load(script: string): Promise<XMScript> {
        // Let's ensure it is already an array
        if (!(script.startsWith("[") && script.endsWith("]"))) {
            script = "[" + script + "]"
        }
        const xmscript: XMScript = JSON.parse(script)
        return xmscript
    }

    /** Returns `script` when it is well formed; throws with the reason otherwise. */
    static prepare(script: unknown): XMScript {
        const refusal = xmScriptRefusal(script)
        if (refusal) throw new Error(refusal)
        return script as XMScript
    }

    // INFO This returns the results of the execution of the XMScript
    static async execute(fullscript: XMScript): Promise<{
        [operationId: string]: {
            result: string
            error?: string
        }
    }> {
        const results = {}
        let operation: IOperation
        // Runs in the key order of `operations`; operations_order is not read.
        const names = Object.keys(fullscript.operations)
        for (const name of names) {
            try {
                operation = fullscript.operations[name]
                log.debug(
                    `[XMParser] ${name}: ${operation?.task?.type} on ${operation?.chain}.${operation?.subchain}`,
                )
                const result = await XMParser.executeOperation(operation)
                results[name] = result
                log.debug(`[XMParser] ${name}: ${result?.result}`)
            } catch (e) {
                log.error("[XM EXECUTE] Error: " + e)
                results[name] = { result: "error", error: e.toString() }
            }
        }

        return results // REVIEW Is the type ok?
    }

    // INFO Only executes one operation
    static async executeOperation(operation: IOperation): Promise<any> {
        // chainID is 0 except for EVM chains
        // NOTE This snippet is what we need to support all the EVM chains
        let chainID = 0
        if (operation.is_evm) {
            // Choosing the right chain ID
            // TODO Use online resources to get the chain ID infos

            chainID = parseInt(operation.subchain, 10)
            if (isNaN(chainID)) {
                const chainConfig = chainIds[operation.chain]
                if (!chainConfig) {
                    return {
                        result: "error",
                        error: "Invalid chain or subchain",
                    }
                }

                chainID = chainConfig[operation.subchain]
                if (isNaN(chainID)) {
                    return {
                        result: "error",
                        error: "Invalid chain or subchain",
                    }
                }
            }
        }

        // REVIEW Would this work?
        // Read operations
        // let res = await multichain[operation.chain][operation.task.type](operation.task.params)

        // TODO Checking if we have a conditional operation
        // ANCHOR MVP
        /* SECTION Write tasks */
        switch (operation.task?.type) {
            case "pay": {
                const result = await handlePayOperation(operation, chainID)
                // The send may already have happened: report a missing reply
                // as a failed op instead of throwing on it.
                if (result === null || typeof result !== "object") {
                    return {
                        result: "error",
                        error: "Executor returned no result",
                        chain: `${operation.chain}.${operation.subchain}`,
                    }
                }
                result["chain"] = `${operation.chain}.${operation.subchain}`
                return result
            }

            /* SECTION Read only tasks */
            // Reads send nothing signed; pay and contract_write check their payloads.
            // ANCHOR MVP
            // INFO Read contract task
            case "contract_read":
                return await handleContractRead(operation, chainID)
            case "contract_write": {
                return await handleContractWrite(operation, chainID)
            }
            case "balance_query":
                return await handleBalanceQuery(operation, chainID)

            default:
                return {
                    result: "error",
                    error: "Unknown task type: " + operation.task?.type,
                }
        }
    }
}

export default XMParser
