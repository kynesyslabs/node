import {
    Hashing,
    hexToUint8Array,
    ucrypto,
    uint8ArrayToHex,
} from "@kynesyslabs/demosdk/encryption"
import { bridge } from "@kynesyslabs/demosdk"
import { getSharedState } from "@/utilities/sharedState"
import { ISignature, RPCResponse } from "@kynesyslabs/demosdk/types"
import { JsonConfig } from "@/utilities/JsonConfig"
import Chain from "../blockchain/chain"

// TODO Better error handling
/**
 * Manages the native bridge operation to send back to the client a compiled operation as a RPCResponse
 * @param operation
 * @returns RPCResponse containing the compiled operation
 */
export async function manageNativeBridge(
    operation: bridge.NativeBridgeOperation,
    signature: ISignature,
): Promise<RPCResponse> {
    // Prepare the response
    // eslint-disable-next-line prefer-const
    let response: RPCResponse = {
        result: null,
        response: null,
        require_reply: false,
        extra: {},
    }

    // First, verify the signature
    const publicKey = operation.address
    const opHash = Hashing.sha256(JSON.stringify(operation))
    const verified = ucrypto.verify({
        algorithm: signature.type,
        signature: hexToUint8Array(signature.data),
        message: new TextEncoder().encode(opHash),
        publicKey: hexToUint8Array(publicKey),
    })

    if (!verified) {
        response.result = 400
        response.response = {
            error: "Invalid signature",
        }

        return response
    }

    // Parse the operation to get the right compiled operation content
    const derivedContent = await parseOperation(operation)

    const hash = Hashing.sha256(JSON.stringify(derivedContent))
    const compiledSignature = await ucrypto.sign(
        getSharedState.signingAlgorithm,
        new TextEncoder().encode(hash),
    )

    const compiledOperation: bridge.NativeBridgeOperationCompiled = {
        content: derivedContent,
        signature: {
            type: getSharedState.signingAlgorithm,
            data: uint8ArrayToHex(compiledSignature.signature),
        },
        rpcPublicKey: getSharedState.publicKeyHex,
    }
    // TODO Generate the deposit addresses based on the operation chains
    // TODO Generate the validUntil value based on current block + 3
    // Incorporate the compiled operation into a RPCResponse
    response.response = compiledOperation
    // Return the response
    return response
}

/**
 * Parses the operation to get the right compiled operation content
 * @param operation
 * @returns The compiled operation content
 */
async function parseOperation(
    operation: bridge.NativeBridgeOperation,
): Promise<bridge.CompiledContent> {
    const contracts = JsonConfig.getUsdcContracts()
    const contract = contracts[operation.from.chain][operation.from.subchain]

    if (!contract) {
        throw new Error(
            `No contract found for ${operation.from.chain}.${operation.from.subchain}`,
        )
    }

    let tankData: bridge.SolanaTankData | bridge.EVMTankData = null

    if (operation.from.chain.startsWith("evm")) {
        tankData = await parseEVMOperation(contract, operation)
    } else if (operation.from.chain === "solana") {
        tankData = await parseSOLANAOperation(contract, operation)
    } else {
        throw new Error(`Unsupported chain: ${operation.from.chain}`)
    }

    const lastBlockNumber = await Chain.getLastBlockNumber()

    return {
        operation,
        tankData,
        validUntil: lastBlockNumber + 3,
    }
}

async function parseEVMOperation(
    contract: string,
    operation: bridge.NativeBridgeOperation,
): Promise<bridge.EVMTankData> {
    return {
        type: "evm",
        abi: [],
        address: contract,
        amountExpected: operation.token.amount,
    }
}

async function parseSOLANAOperation(
    contract: string,
    operation: bridge.NativeBridgeOperation,
): Promise<bridge.SolanaTankData> {
    return {
        type: "solana",
        address: contract,
        amountExpected: operation.token.amount,
    }
}
