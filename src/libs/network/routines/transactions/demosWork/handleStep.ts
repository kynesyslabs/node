import { WorkStep } from "@kynesyslabs/demosdk/demoswork"
import log from "src/utilities/logger"
import { StepResult } from "./handleDemosWorkRequest"
// SECTION Operation types
import { IWeb2Request, XMScript } from "@kynesyslabs/demosdk/types"
// SECTION Handlers
import { INativePayload } from "node_modules/@kynesyslabs/demosdk/build/types/native"
import multichainDispatcher from "src/features/multichain/XMDispatcher"
import { handleWeb2ProxyRequest } from "../handleWeb2ProxyRequest"
import { isFullWeb2Request } from "src/features/web2/web2PayloadProcessor"
import required from "src/utilities/required"
// ? Remove this proxy if possible
let handleXMRequest = multichainDispatcher

// ANCHOR - Handle the step
// This method is responsible for handling the step and compiling the result
export default async function handleStep(step: WorkStep): Promise<StepResult> {
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
        required(
            isFullWeb2Request(task),
            "Invalid Web2 request in DemosWork step",
        )
        const web2Request = task as IWeb2Request
        result = await handleWeb2ProxyRequest(web2Request)
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
