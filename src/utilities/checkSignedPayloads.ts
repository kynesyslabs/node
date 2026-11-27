import type { IOperation } from "@kynesyslabs/demosdk/types"

const HEX = /^(0x)?[0-9a-fA-F]+$/

function payloadShapeRefusal(
    operation: Pick<IOperation, "chain" | "is_evm">,
    payload: unknown,
): string | null {
    // EVM and Aptos executors decode the payload as hex bytes; the other
    // chains take a string or a serialized object their SDK client parses.
    if (operation.is_evm || operation.chain === "aptos") {
        return typeof payload === "string" && HEX.test(payload)
            ? null
            : "signed payload is not a hex string"
    }
    if (typeof payload === "string") {
        return payload.trim() !== "" ? null : "signed payload is empty"
    }
    if (payload !== null && typeof payload === "object") {
        return Object.keys(payload).length > 0
            ? null
            : "signed payload is empty"
    }
    return "signed payload is neither a string nor an object"
}

/**
 * Why an operation that sends a signed transaction does not carry exactly
 * `num` payloads of the shape its chain's executor reads, or null. Whether a
 * signature is valid is left to the target chain.
 */
export function signedPayloadsRefusal(
    num: number,
    operation: Pick<IOperation, "chain" | "is_evm"> & {
        task?: { signedPayloads?: unknown }
    },
): string | null {
    const payloads = operation.task?.signedPayloads
    if (!Array.isArray(payloads)) return "signedPayloads is not a list"
    if (payloads.length !== num) {
        return `Invalid signedPayloads length: expected ${num}, got ${payloads.length}`
    }
    for (const payload of payloads) {
        const refusal = payloadShapeRefusal(operation, payload)
        if (refusal) return refusal
    }
    return null
}
