import type {
    ExecuteWithHooksRequest,
    HookExecutionResult,
    ScriptMethodRequest,
    ScriptMethodResult,
    ScriptViewRequest,
    ScriptViewResult,
} from "./shared"

const BIGINT_TAG = "$demos_bigint_v1"

export type WorkerRequest =
    | { id: string; kind: "view"; payload: ScriptViewRequest }
    | { id: string; kind: "method"; payload: ScriptMethodRequest }
    | { id: string; kind: "hooks"; payload: ExecuteWithHooksRequest }

export type WorkerResponse =
    | { id: string; ok: true; result: ScriptViewResult | ScriptMethodResult | HookExecutionResult }
    | { id: string; ok: false; error: string }

export function stringifyWorkerMessage(message: WorkerRequest | WorkerResponse): string {
    return `${JSON.stringify(message, (_key, value) => {
        if (typeof value === "bigint") {
            return { [BIGINT_TAG]: value.toString() }
        }
        return value
    })}\n`
}

export function parseWorkerMessage<T>(line: string): T {
    return JSON.parse(line, (_key, value) => {
        if (
            value &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            typeof value[BIGINT_TAG] === "string" &&
            Object.keys(value).length === 1
        ) {
            return BigInt(value[BIGINT_TAG])
        }
        return value
    }) as T
}
