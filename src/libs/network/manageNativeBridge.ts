import { getSharedState } from "@/utilities/sharedState"
import { bridge } from "@kynesyslabs/demosdk"
import { RPCResponse } from "@kynesyslabs/demosdk/types"

// TODO Better error handling
/**
 * Manages the native bridge operation to send back to the client a compiled operation as a RPCResponse
 * @param operation 
 * @returns RPCResponse containing the compiled operation
 */
export async function manageNativeBridge(
    operation: bridge.NativeBridgeOperation,
): Promise<RPCResponse> {
    // eslint-disable-next-line prefer-const
    let response: RPCResponse = {
        result: 200,
        response: null,
        require_reply: false,
        extra: null,
    }
    // Parse the operation to get the right compiled operation content
    const derivedContent: bridge.NativeBridgeOperationCompiled["content"] = parseOperation(operation)
    // eslint-disable-next-line prefer-const
    let compiledOperation: bridge.NativeBridgeOperationCompiled = {
        content: derivedContent,
        // FIXME: Signature generation not yet implemented - operation is unsigned
        // Once implemented: sign derivedContent with node's private key, set type to signing algorithm
        signature: { type: "", data: "" },
        rpcPublicKey: getSharedState.identity.ed25519_hex.publicKey,
    }
    // TODO Generate the validUntil value based on current block + 3
    // Incorporate the compiled operation into a RPCResponse
    response.response = compiledOperation
    // TODO Return the response
    return response
}

/**
 * Parses the operation to get the right compiled operation content
 * @param operation 
 * @returns The compiled operation content
 */
function parseOperation(operation: bridge.NativeBridgeOperation): bridge.NativeBridgeOperationCompiled["content"] {
    let derivedContent: bridge.NativeBridgeOperationCompiled["content"]
    if (operation.originChainType === "EVM") {
        derivedContent = parseEVMOperation(operation)
    } else if (operation.originChainType === "SOLANA") {
        derivedContent = parseSOLANAOperation(operation)
    }
    return derivedContent
}

function parseEVMOperation(operation: bridge.NativeBridgeOperation): bridge.NativeBridgeOperationCompiled["content"] {
    // TODO Implement the parsing
    return null
}

function parseSOLANAOperation(operation: bridge.NativeBridgeOperation): bridge.NativeBridgeOperationCompiled["content"] {
    // TODO Implement the parsing
    return null
}
