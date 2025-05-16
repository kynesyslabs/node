import { Cryptography, Hashing } from "@kynesyslabs/demosdk/encryption"
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
    signature: string,
): Promise<RPCResponse> {
    // Prepare the response
    // eslint-disable-next-line prefer-const
    let response: RPCResponse = {
        result: 200,
        response: null,
        require_reply: false,
        extra: null,
    }
    // First, verify the signature
    const publicKey = operation.demoAddress
    const opHash = Hashing.sha256(JSON.stringify(operation))
    const verified = Cryptography.verify(opHash, signature, publicKey)
    if (!verified) {
        response.result = 400
        response.response = "Invalid signature"
        return response
    }
    // Parse the operation to get the right compiled operation content
    const derivedContent: bridge.NativeBridgeOperationCompiled["content"] = parseOperation(operation)
    // eslint-disable-next-line prefer-const
    let compiledOperation: bridge.NativeBridgeOperationCompiled = {
        content: derivedContent,
        signature: "",
        rpc: getSharedState.identity.ed25519_hex.publicKey, 
    }
    // TODO Generate the deposit addresses based on the operation chains
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
    if (operation.originChain === "EVM") {
        derivedContent = parseEVMOperation(operation)
    } else if (operation.originChain === "SOLANA") {
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
