import { DemoScript, DemosWorkOperationScripts } from "@kynesyslabs/demosdk/types"
import log from "src/utilities/logger"
import { OperationResult } from "./handleDemosWorkRequest"
import handleStep from "./handleStep"

// ANCHOR - Process the operations
// This method is responsible for iterating over the operations and steps
// and executing them
export async function processOperations(
    script: DemoScript,
): Promise<[DemoScript, OperationResult[]]> {
    let operationsResults: OperationResult[] = []
    for (const operationName of script.operationOrder) {
        const operation: DemosWorkOperationScripts = script.operations[operationName]
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

            for (const workId of operation.id) {
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
