import {
    WorkStep,
} from "@kynesyslabs/demosdk/demoswork"
import {
    DemoScript,
    DemosWorkOperationScripts,
    RPCResponse,
} from "@kynesyslabs/demosdk/types"
import _ from "lodash"
import log from "src/utilities/logger"
import { emptyResponse } from "../../../server_rpc"
import { processOperations } from "./processOperations"
// SECTION Operation types
// SECTION Handlers
import multichainDispatcher from "src/features/multichain/XMDispatcher"
// ? Remove this proxy if possible
let handleXMRequest = multichainDispatcher

/* TODO Log
- add to the DemoScript logic a flag to specify if a step is mandatory or not
- add to the DemoScript logic a flag to specify if an operation is mandatory or not
- ? add to the DemoScript logic a flag to specify if a step depends on the previous step(s)
- ? add to the DemoScript logic a flag to specify if an operation depends on the previous operation(s)
*/

/* Quick logic reference
- A DemoScript is composed of operations
- An operation is composed of steps
- A step is composed of a context and a task
- They get executed in the order specified by the operationOrder property of DemoScript
- The methods below are in order of nesting
*/

// ? Remove the dump below when the logic is implemented fully and correctly
/* NOTE Reference dump of a received demosWork request (xm, no conditional) 
    
    {
        "operationOrder": [
            "op_57ab0baebbf349869c01382bac1cc60a"
        ],
        "operations": {
            "op_57ab0baebbf349869c01382bac1cc60a": {
            "operationType": "base",
            "work": [
                "step_fe3bd97f68cf47ccb89c6a237ec530d4"
            ]
            }
        },
        "steps": {
            "step_fe3bd97f68cf47ccb89c6a237ec530d4": {
            "timestamp": 1727371958699,
            "content": {
                "operations": {
                "adfc5756-ce70-44f7-813c-fde6a831e9a0": {
                    "chain": "eth",
                    "is_evm": true,
                    "rpc_url": null,
                    "subchain": "sepolia",
                    "task": {
                    "params": null,
                    "signedPayloads": [
                        []
                    ],
                    "type": "contract_read"
                    }
                }
                },
                "operations_order": [
                "adfc5756-ce70-44f7-813c-fde6a831e9a0"
                ]
            },
            "context": "xm",
            "description": "Send ETH"
            }
        }
    }

    */

// ANCHOR Types for handling the steps and operations results

export type StepResult = {
    step: WorkStep
    success: boolean
    error?: string
}

export type OperationResult = {
    operation: DemosWorkOperationScripts
    success: boolean
    error?: string
}

// ANCHOR - Handle the demosWork request
export default async function handleDemosWorkRequest(
    content: DemoScript,
): Promise<RPCResponse> {
    var compiledScript: DemoScript = _.cloneDeep(content)
    var operationsResults: OperationResult[] = []
    const response: RPCResponse = _.cloneDeep(emptyResponse)

    log.info("[demosWork] [handleDemosWorkRequest] Received a DemoScript: ")
    console.log(content)

    /* TODO As this fails if any step fails, we need to ensure that if not
    explicitly specified otherwise, the steps are executed even if one fails with a
    fallback to the next step and a meaningful error(s) log in the return value */
    try {
        [compiledScript, operationsResults] = await processOperations(content)
        response.result = 200
        response.response = {
            compiledScript: compiledScript,
            operationsResults: operationsResults,
        }
    } catch (error) {
        log.error(
            "[demosWork] [handleDemosWorkRequest] Error processing DemoScript: " +
                error,
        )
        response.result = 400
        response.extra =
            error instanceof Error ? error.message : "Unknown error occurred"
        response.response = {
            compiledScript: compiledScript,
            operationsResults: operationsResults,
        } // Return the partially compiled script even on error
    }

    return response
}
