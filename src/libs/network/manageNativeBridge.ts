import {
    Hashing,
    hexToUint8Array,
    ucrypto,
    uint8ArrayToHex,
} from "@kynesyslabs/demosdk/encryption"
import { getSharedState } from "@/utilities/sharedState"
import { ISignature, RPCResponse } from "@kynesyslabs/demosdk/types"
import { JsonConfig } from "@/utilities/JsonConfig"
import Chain from "../blockchain/chain"
import { EVMSmartContractManagement } from "@/features/bridges/native/EVMSmartContractManagement"
import log from "@/utilities/logger"

// REVIEW: Temporary import from local SDK build to fix version mismatch
import type {
    NativeBridgeOperation,
    NativeBridgeOperationCompiled,
    CompiledContent,
    EVMTankData,
    SolanaTankData,
} from "@kynesyslabs/demosdk/bridge" // FIXME Once we have a proper SDK build, use the correct import path

// Global tank management singleton
let tankManager: EVMSmartContractManagement | null = null

/**
 * Initialize tank management system with deployed addresses
 */
export async function initializeTankManager(): Promise<void> {
    if (tankManager && tankManager.isReady()) {
        return // Already initialized
    }

    try {
        tankManager = EVMSmartContractManagement.getInstance()
        const tankAddresses = JsonConfig.getTankAddresses()

        // Filter out undeployed tanks (address = 0x000...)
        const deployedTanks = Object.fromEntries(
            Object.entries(tankAddresses).filter(
                ([_, address]) =>
                    !address.includes("000000000000000"),
            ),
        )

        console.log("deployedTanks", deployedTanks)

        if (Object.keys(deployedTanks).length === 0) {
            log.warning("No deployed tank addresses found in configuration")
            return
        }

        await tankManager.initialize(deployedTanks)
        log.info(
            `Tank manager initialized with ${
                Object.keys(deployedTanks).length
            } tanks`,
        )
    } catch (error) {
        log.error("Failed to initialize tank manager: " + error)
        throw error
    }
}

// REVIEW: Initialize tank manager on module load
/**
 * Manages the native bridge operation to send back to the client a compiled operation as a RPCResponse
 * @param operation
 * @returns RPCResponse containing the compiled operation
 */
export async function manageNativeBridge(
    operation: NativeBridgeOperation,
    signature: ISignature,
): Promise<RPCResponse> {
    // // Initialize tank manager if needed
    // NOW done on node startup
    // await initializeTankManager()

    // Prepare the response
     
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

    try {
        // Parse the operation to get the right compiled operation content
        const derivedContent = await parseOperation(operation)

        const hash = Hashing.sha256(JSON.stringify(derivedContent))
        const compiledSignature = await ucrypto.sign(
            getSharedState.signingAlgorithm,
            new TextEncoder().encode(hash),
        )

        const compiledOperation: NativeBridgeOperationCompiled = {
            content: derivedContent,
            signature: {
                type: getSharedState.signingAlgorithm,
                data: uint8ArrayToHex(compiledSignature.signature),
            },
            rpcPublicKey: getSharedState.publicKeyHex,
        }

        // REVIEW: Now using deployed tank addresses instead of USDC contract addresses
        response.response = compiledOperation
        return response
    } catch (error) {
        response.result = 400
        response.response = {
            error: `Failed to process bridge operation: ${error}`,
        }
        return response
    }
}

/**
 * Parses the operation to get the right compiled operation content using deployed tank addresses
 * @param operation Native bridge operation from client
 * @returns The compiled operation content with tank data
 */
async function parseOperation(
    operation: NativeBridgeOperation,
): Promise<CompiledContent> {
    const fromChainKey = `${operation.from.chain}.${operation.from.subchain}`

    let tankData: SolanaTankData | EVMTankData = null

    if (operation.from.chain.startsWith("evm")) {
        tankData = await parseEVMTankOperation(fromChainKey, operation)
    } else if (operation.from.chain === "solana") {
        tankData = await parseSolanaTankOperation(fromChainKey, operation)
    } else {
        throw new Error(`Unsupported source chain: ${operation.from.chain}`)
    }

    const lastBlockNumber = await Chain.getLastBlockNumber()

    return {
        operation,
        tankData,
        validUntil: lastBlockNumber + 3,
    }
}

/**
 * Parse EVM tank operation using deployed tank address
 * @param chainKey EVM chain key (e.g., "eth.sepolia")
 * @param operation Bridge operation
 * @returns EVM tank data with deployed contract address
 */
async function parseEVMTankOperation(
    chainKey: string,
    operation: NativeBridgeOperation,
): Promise<EVMTankData> {
    if (!tankManager) {
        throw new Error("Tank manager not initialized")
    }

    const tankConfig = tankManager.getTankConfig(chainKey)
    if (!tankConfig) {
        throw new Error(`No deployed tank found for chain: ${chainKey}`)
    }

    // REVIEW: Get the liquidityTank ABI for the compiled operation
    const liquidityTankABI = [
        "function getBalance(address token) view returns (uint256)",
        "function multisigTransfer(bytes32 proposalId, address token, address to, uint256 amount)",
        "function proposeNextOwners(bytes32 proposalId, address[] newOwners)",
        "event TransferExecuted(address indexed token, address indexed to, uint256 amount)",
    ]

    return {
        type: "evm",
        abi: liquidityTankABI,
        address: tankConfig.address,
        amountExpected: operation.token.amount,
    }
}

/**
 * Parse Solana tank operation using treasury program address
 * @param chainKey Solana chain key (e.g., "solana.devnet")
 * @param operation Bridge operation
 * @returns Solana tank data
 */
async function parseSolanaTankOperation(
    chainKey: string,
    operation: NativeBridgeOperation,
): Promise<SolanaTankData> {
    // REVIEW: For now using USDC program address until Solana treasury is implemented
    const usdcContracts = JsonConfig.getUsdcContracts()
    const solanaUsdcAddress = usdcContracts.solana?.[operation.from.subchain]

    if (!solanaUsdcAddress) {
        throw new Error(
            `No Solana USDC program found for subchain: ${operation.from.subchain}`,
        )
    }

    // TODO: Replace with actual treasury program address once SolanaAddressManagement is implemented
    return {
        type: "solana",
        address: solanaUsdcAddress, // Temporary - will be treasury program address
        amountExpected: operation.token.amount,
    }
}
