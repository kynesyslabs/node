import { chainIds } from "sdk/localsdk/multichain/configs/chainIds"
import { chainProviders } from "sdk/localsdk/multichain/configs/chainProviders"
import { evmProviders } from "sdk/localsdk/multichain/configs/evmProviders"
import {
    MAX_XM_OPERATIONS,
    XM_MAX_OPERATION_NAME_LENGTH,
} from "src/utilities/constants"

const XM_TASK_TYPES = new Set([
    "pay",
    "contract_read",
    "contract_write",
    "balance_query",
])

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false
    }
    const proto = Object.getPrototypeOf(value)
    return proto === Object.prototype || proto === null
}

function isKnownChain(chain: string): boolean {
    return [chainProviders, evmProviders, chainIds].some(table =>
        Object.hasOwn(table, chain),
    )
}

function operationRefusal(name: string, op: unknown): string | null {
    const where = `operation "${name}"`
    if (!isPlainObject(op)) return `${where} is not an object`
    if (typeof op.chain !== "string" || !isKnownChain(op.chain)) {
        return `${where} names an unknown chain`
    }
    const subchain = op.subchain
    const subchainOk =
        (typeof subchain === "string" && subchain !== "") ||
        Number.isSafeInteger(subchain)
    if (!subchainOk) return `${where} has no subchain`
    if (op.is_evm !== undefined && typeof op.is_evm !== "boolean") {
        return `${where} has a non-boolean is_evm`
    }
    if (op.rpc !== undefined && op.rpc !== null && typeof op.rpc !== "string") {
        return `${where} has a non-string rpc`
    }
    const task = op.task
    if (!isPlainObject(task)) return `${where} has no task`
    if (typeof task.type !== "string" || !XM_TASK_TYPES.has(task.type)) {
        return `${where} has an unknown task type`
    }
    if (
        task.params !== undefined &&
        task.params !== null &&
        typeof task.params !== "object"
    ) {
        return `${where} has task params that are not an object`
    }
    const payloads = task.signedPayloads
    if (payloads !== undefined && !Array.isArray(payloads)) {
        return `${where} has signedPayloads that are not a list`
    }
    if (
        Array.isArray(payloads) &&
        payloads.some(p => typeof p !== "string" && (p === null || typeof p !== "object"))
    ) {
        return `${where} has a signed payload that is neither a string nor an object`
    }
    return null
}

/**
 * Why `script` is not an XM script this node can run, or null. Checked before
 * a fee is quoted and again before any operation is sent, so a malformed
 * script never reaches another chain.
 */
export function xmScriptRefusal(script: unknown): string | null {
    if (!isPlainObject(script)) return "XM script is not an object"
    const operations = script.operations
    if (
        !isPlainObject(operations) ||
        Object.keys(operations).length > MAX_XM_OPERATIONS
    ) {
        return `XM script refused: operations must be an object of at most ${MAX_XM_OPERATIONS} entries`
    }
    const names = Object.keys(operations)
    if (names.length === 0) return "XM script has no operations"
    const order = script.operations_order
    if (
        order !== undefined &&
        (!Array.isArray(order) ||
            order.length > MAX_XM_OPERATIONS ||
            order.some(entry => typeof entry !== "string"))
    ) {
        return "XM script operations_order is not a list of operation names"
    }
    for (const name of names) {
        if (name.length > XM_MAX_OPERATION_NAME_LENGTH) {
            return `XM script has an operation name over ${XM_MAX_OPERATION_NAME_LENGTH} characters`
        }
        const refusal = operationRefusal(name, operations[name])
        if (refusal) return `XM script ${refusal}`
    }
    return null
}

/**
 * Why a DemosWork script's cross-chain steps are not XM scripts this node can
 * run, or null. Steps of other contexts are left to their own handlers.
 */
export function demoScriptXmRefusal(script: unknown): string | null {
    if (!isPlainObject(script) || !isPlainObject(script.steps)) return null
    for (const step of Object.values(script.steps)) {
        if (!isPlainObject(step) || step.context !== "xm") continue
        const refusal = xmScriptRefusal(step.content)
        if (refusal) return refusal
    }
    return null
}
