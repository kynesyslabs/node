import type { DemoScript } from "@kynesyslabs/demosdk/types"

/** Most step runs a DemosWork script may ask for, over all its operations. */
export const MAX_DEMOSWORK_STEP_RUNS = 64

function isDistinctNames(list: unknown): list is string[] {
    return (
        Array.isArray(list) &&
        list.every(entry => typeof entry === "string") &&
        new Set(list).size === list.length
    )
}

/**
 * Why `script` must not run, or null when it may. processOperations runs one
 * operation per operationOrder entry and one step per entry of a base
 * operation's id, so both must be arrays of distinct names, a step id may be
 * listed by at most one base operation in operationOrder, and those operations
 * may add up to at most MAX_DEMOSWORK_STEP_RUNS step runs.
 */
export function demoScriptRefusal(script: DemoScript): string | null {
    const order: unknown = script?.operationOrder
    if (!isDistinctNames(order)) {
        return "DemosWork script refused: operationOrder must list distinct operation names"
    }
    const listedSteps = new Set<string>()
    let stepRuns = 0
    for (const name of order) {
        const operation: any = script.operations?.[name]
        if (operation?.operationType !== "base") continue
        const stepIds: unknown = operation.id
        if (!Array.isArray(stepIds)) {
            return "DemosWork script refused: operation step list missing or not distinct"
        }
        // Checked on the length alone, before any step id is read.
        if (stepRuns + stepIds.length > MAX_DEMOSWORK_STEP_RUNS) {
            return `DemosWork script refused: more than ${MAX_DEMOSWORK_STEP_RUNS} step runs`
        }
        if (
            !isDistinctNames(stepIds) ||
            stepIds.some(stepId => listedSteps.has(stepId))
        ) {
            return "DemosWork script refused: operation step list missing or not distinct"
        }
        stepIds.forEach(stepId => listedSteps.add(stepId))
        stepRuns += stepIds.length
    }
    return null
}
