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

export default async function handleDemosWorkRequest(
    content: DemoScript,
): Promise<RPCResponse> {
    let compiledScript: DemoScript = _.cloneDeep(content)
    let response: RPCResponse = _.cloneDeep(emptyResponse)
    log.info("[demosWork] [handleDemosWorkRequest] Received a DemoScript: ")
    console.log(content)

    /* TODO Logic */
    // Check the operations order and put the operations in order in a list of operations
    let orderedOperations: DemosWorkOperationScripts[] = []
    for (const operationName of content.operationOrder) {
        let currentOperation: DemosWorkOperationScripts =
            content.operations[operationName]
        orderedOperations.push(currentOperation)
    }
    console.log(
        "[demosWork] [handleDemosWorkRequest] Ordered operations: ",
        orderedOperations,
    )
    // For each operation, check the type of operation
    for (const operation of orderedOperations) {
        if (operation.operationType === "base") {
            console.log(
                "[demosWork] [handleDemosWorkRequest] Base operation detected: iterating over the works",
            )
            // If base, iterate over the works
            for (const work of operation.work) {
                let currentStep = content.steps[work]
                console.log(
                    "[demosWork] [handleDemosWorkRequest] Current step: ",
                    currentStep,
                )
                // Check the step context and call the corresponding handler
                currentStep = await handleStep(currentStep)
                console.log(
                    "[demosWork] [handleDemosWorkRequest] Compiled step result: ",
                    currentStep.output,
                )
                // Replace the original step with the compiled step
                compiledScript.steps[work] = currentStep
            }
        } else {
            // TODO: Implement conditional operations
            // ? Is this the right way to return an error?
            response.result = 400
            response.response =
                "Conditional operations are not implemented yet (in operation: " +
                operation.id +
                ")"
            return response
        }
    }
    // Return the compiled script with the steps replaced by the compiled steps (aka with the output)
    response.result = 200
    response.response = compiledScript
    response.extra = null
    return response
}

// Handling and compiling the step
async function handleStep(step: WorkStep): Promise<WorkStep> {
    // ? Do we have to do any additional check on the step?
    // Iterating over the step content
    let context = step.context
    let task = step.content
    let result: any = null
    log.info(
        "[demosWork] [handleStep] Handling a step with context: " +
            context +
            " and description: " +
            step.description,
    )
    if (context === "xm") {
        // REVIEW Implement the logic for xm steps
        let xmScript = task as XMScript
        result = await handleXMRequest.digest(xmScript)
    } else if (context === "web2") {
        let web2Request = task as IWeb2Request
        result = await handleWeb2Request(web2Request)
    } else {
        let nativePayload = task as INativePayload
        // TODO: Implement the logic for native steps
        result = "Not implemented"
    }
    // Compile the step result
    // ? Check typing with jeff
    step.output = result
    return step
}
