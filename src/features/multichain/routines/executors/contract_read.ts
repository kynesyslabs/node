import type { IOperation } from "@kynesyslabs/demosdk/types"
import { Interface, type FunctionFragment } from "ethers"
import { EVM } from "@kynesyslabs/demosdk/xm-localsdk"
import { configuredEvmUrl } from "./rpcUrl"
import { handleAptosContractReadRest } from "./aptos_contract_read"
import log from "@/utilities/logger"
import { logField } from "../errorKind"

type EvmReadCall =
    | { ok: true; fragment: FunctionFragment; args: unknown[] }
    | { ok: false; error: string }

function readArgs(raw: unknown): unknown[] | null {
    if (raw === undefined || raw === null || raw === "") return []
    let value = raw
    if (typeof raw === "string") {
        try {
            value = JSON.parse(raw)
        } catch {
            return null
        }
    }
    if (Array.isArray(value)) return value
    if (value !== null && typeof value === "object") return Object.values(value)
    return null
}

/**
 * The view or pure ABI function a read names and its arguments, or why the
 * read is refused. The caller supplies the ABI, so the method is looked up in
 * it rather than on the contract object, whose own members (connect, runner,
 * getAddress, ...) would otherwise answer to the same name.
 */
export function evmReadCall(params: unknown): EvmReadCall {
    if (params === null || typeof params !== "object") {
        return { ok: false, error: "Missing contract read params" }
    }
    const p = params as Record<string, unknown>
    if (!p.address) return { ok: false, error: "Missing contract address" }
    if (!p.abi) return { ok: false, error: "Missing contract ABI" }
    if (typeof p.method !== "string" || p.method === "") {
        return { ok: false, error: "Missing contract method" }
    }

    let fragment: FunctionFragment | null
    try {
        fragment = new Interface(p.abi as string).getFunction(p.method)
    } catch (e) {
        return {
            ok: false,
            error: `Invalid contract ABI or ambiguous method: ${
                e instanceof Error ? e.message : String(e)
            }`,
        }
    }
    if (!fragment) {
        return { ok: false, error: `Method ${p.method} is not in the ABI` }
    }
    if (!fragment.constant) {
        return {
            ok: false,
            error: `Method ${p.method} is not a view or pure function`,
        }
    }

    const args = readArgs(p.params)
    if (!args) {
        return {
            ok: false,
            error: "Invalid contract method params: expected a JSON list or object",
        }
    }
    return { ok: true, fragment, args }
}

/**
 * An EVM read uses only the node's configured RPC for the chain, on a
 * connection of its own: the SDK's per-chain instance, which pay and
 * contract_write broadcast through, is never created or replaced here.
 */
async function handleEvmContractRead(operation: IOperation, chainID: number) {
    const call = evmReadCall(operation.task?.params)
    if (call.ok === false) return { result: "error", error: call.error }

    const providerUrl = configuredEvmUrl(operation.chain, operation.subchain)
    if (!providerUrl) {
        return {
            result: "error",
            error: `RPC URL not found for ${operation.chain}.${operation.subchain}`,
        }
    }
    const params = operation.task.params
    const evmInstance = new EVM(providerUrl, chainID)
    try {
        await evmInstance.connect()
        const contractInstance = await evmInstance.getContractInstance(
            params.address,
            params.abi,
        )
        const result = await contractInstance.getFunction(call.fragment.format())(
            ...call.args,
        )
        log.debug("result from EVM read call received")
        return {
            result: result,
            status: true,
        }
    } finally {
        evmInstance.provider?.destroy?.()
    }
}

/** Reads a contract on an EVM chain or on Aptos. */
export default async function handleContractRead(
    operation: IOperation,
    chainID: number,
) {
    log.debug(
        `[XM Method] Read contract on ${logField(operation.chain)}.${logField(operation.subchain)}`,
    )
    if (operation.is_evm) {
        return await handleEvmContractRead(operation, chainID)
    }
    if (operation.chain === "aptos") {
        return await handleAptosContractReadRest(operation)
    }
    return {
        result: "error",
        error: `Not implemented yet: contract_read on ${operation.chain} chain`,
    }
}
