import log from "src/utilities/logger"
import {
    DemoScript,
    DemosWorkOperationScripts,
    IWeb2Request,
} from "@kynesyslabs/demosdk/types"
import {
    DemosWork,
    DemosWorkOperation,
    WorkStep,
} from "@kynesyslabs/demosdk/demoswork"
import { RPCResponse } from "@kynesyslabs/demosdk/types"
import { emptyResponse } from "../../server_rpc"
import _ from "lodash"
// SECTION Operation types
import { XMScript, IWeb2Payload } from "@kynesyslabs/demosdk/types"
// SECTION Handlers
import handleWeb2Request from "./handleWeb2Request"
import multichainDispatcher from "src/features/multichain/XMDispatcher"
import { INativePayload } from "node_modules/@kynesyslabs/demosdk/build/types/native"
import executeNativeTransaction from "src/libs/blockchain/routines/executeNativeTransaction"
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

// ANCHOR - Process the operations
// This method is responsible for iterating over the operations and steps
// and executing them
async function processOperations(
    script: DemoScript,
): Promise<[DemoScript, OperationResult[]]> {
    let operationsResults: OperationResult[] = []
    for (const operationName of script.operationOrder) {
        const operation = script.operations[operationName]
        // Prepare the operation result
        let operationResult: OperationResult = {
            operation: operation,
            success: true,
            error: "",
        }

        // Process the base operation
        if (operation.operationType === "base") {
            log.info(
                "[demosWork] [processOperations] Base operation detected: iterating over the works",
            )

            for (const workId of operation.work) {
                const currentStep = script.steps[workId]
                const stepResult = await handleStep(currentStep)
                /* NOTE If a step fails, the operation is not successful and
                the error is appended to the operation error */
                if (!stepResult.success) {
                    operationResult.success = false
                    operationResult.error +=
                        "Step '" +
                        stepResult.step.description +
                        "' (id: " +
                        stepResult.step.id +
                        ")' failed with error: " +
                        stepResult.error +
                        "\n"
                    break
                }

                script.steps[workId] = stepResult.step
            }
        } else {
            /* NOTE If the operation is conditional, it is not implemented yet and it fails */
            operationResult.success = false
            operationResult.error =
                "Conditional operations are not implemented yet (operation: " +
                operation.id +
                ")"
            // ? Do we need to compile the script here? Like, the individual steps?
        }
        /* NOTE Append the operation result to the operations results */
        operationsResults.push(operationResult)
    }
    // NOTE Return the script compiled
    return [script, operationsResults]
}

// ANCHOR - Handle the step
// This method is responsible for handling the step and compiling the result
async function handleStep(step: WorkStep): Promise<StepResult> {
    let stepResult: StepResult = {
        step: step,
        success: false,
        error: "Not implemented",
    }
    let result: any = null
    // ? Do we have to do any additional check on the step?
    // Iterating over the step content
    let context = step.context
    let task = step.content
    log.info(
        "[demosWork] [handleStep] Handling a step with context: " +
            context +
            " and description: " +
            step.description,
    )
    stepResult.success = true // Until proven otherwise
    if (context === "xm") {
        // REVIEW Implement the logic for xm steps
        let xmScript = task as XMScript
        result = await handleXMRequest.digest(xmScript)
    } else if (context === "web2") {
        let web2Request = task as IWeb2Request
        result = await handleWeb2Request(web2Request)
    } else if (context === "native") {
        let nativePayload = task as INativePayload
        // TODO: Implement the logic for native steps
        result = "Not implemented"
        stepResult.error = "Not implemented"
        stepResult.success = false
    } else {
        stepResult.error = "Unknown context: " + context
        stepResult.success = false
    }
    // Compile the step result
    // ? Check typing with jeff
    step.output = result
    stepResult.step = step
    return stepResult
}
