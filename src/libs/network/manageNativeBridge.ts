import log from "@/utilities/logger"
import { randomBytes } from "crypto"
import Chain from "../blockchain/chain"
import {
    Hashing,
    hexToUint8Array,
    ucrypto,
    uint8ArrayToHex,
} from "@kynesyslabs/demosdk/encryption"
import { JsonConfig } from "@/utilities/JsonConfig"
import { getSharedState } from "@/utilities/sharedState"
import { ISignature, RPCResponse } from "@kynesyslabs/demosdk/types"
import { EVMSmartContractManagement } from "@/features/bridges/native/EVMSmartContractManagement"

const EvmLiquidityTankABI = [
    {
        inputs: [
            { internalType: "string", name: "bridgeId", type: "string" },
            { internalType: "address", name: "user", type: "address" },
            { internalType: "bytes", name: "signature", type: "bytes" },
            {
                internalType: "address",
                name: "tokenAddress",
                type: "address",
            },
            {
                internalType: "uint256",
                name: "depositAmount",
                type: "uint256",
            },
            { internalType: "string", name: "destChain", type: "string" },
            {
                internalType: "address",
                name: "recipient",
                type: "address",
            },
            {
                internalType: "uint256",
                name: "bridgeFeeBps",
                type: "uint256",
            },
            {
                internalType: "uint256",
                name: "permitDeadline",
                type: "uint256",
            },
            { internalType: "uint8", name: "v", type: "uint8" },
            { internalType: "bytes32", name: "r", type: "bytes32" },
            { internalType: "bytes32", name: "s", type: "bytes32" },
        ],
        name: "depositAndBridgeWithPermit",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
]

function parseAmount(amount: string, decimals: bigint): bigint {
    return BigInt(amount) * 10n ** decimals
}

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
                ([_, address]) => !address.includes("000000000000000"),
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
    log.debug(
        "[manageNativeBridge] Operation: " + JSON.stringify(operation, null, 2),
    )
    log.debug(
        "[manageNativeBridge] Signature: " + JSON.stringify(signature, null, 2),
    )

    let response: RPCResponse = {
        result: 200,
        response: null,
        require_reply: false,
        extra: {},
    }

    try {
        // First, verify the signature
        const publicKey = operation.address
        const opHash = Hashing.sha256(JSON.stringify(operation))
        const verified = ucrypto.verify({
            algorithm: signature.type,
            signature: hexToUint8Array(signature.data),
            message: new TextEncoder().encode(opHash),
            publicKey: hexToUint8Array(publicKey),
        })

        // INFO: Check liquidity on destination chain
        if (operation.to.chain.startsWith("evm")) {
            const tankManager = EVMSmartContractManagement.getInstance()
            const tankConfig = tankManager.getTankConfig(operation.to.chain)

            if (!tankConfig) {
                throw new Error(
                    `No deployed tank found for chain: ${operation.to.chain}`,
                )
            }

            const balance = await tankManager.getUSDCBalance(operation.to.chain)
            const requiredAmount = parseAmount(operation.token.amount, 6n)

            if (balance < requiredAmount) {
                throw new Error(
                    `Insufficient liquidity on ${operation.to.chain}`,
                )
            }
        } else {
            throw new Error(`Unsupported chain: ${operation.to.chain}`)
        }

        if (!verified) {
            response.result = 400
            response.response = {
                error: "Invalid signature",
            }
            return response
        }

        // Generate unique bridge ID for this operation
        // const bridgeId = generateBridgeId(operation)

        // INFO: Check if bridgeId is already executed or expired
        // const bridgeStatus = await tankManager.validateBridgeId(
        //     bridgeId,
        //     operation.to.chain,
        // )

        // if (!bridgeStatus.valid) {
        //     response.result = 400
        //     response.response = {
        //         error: bridgeStatus.message,
        //     }
        //     return response
        // }

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
 * Generate a unique bridge ID for tracking the operation
 *
 * @param operation Native bridge operation from client
 * @returns Unique bridge ID string
 */
function generateBridgeId(operation: NativeBridgeOperation): string {
    // Create deterministic but unique bridge ID using operation data + timestamp + random bytes
    const operationData = `${operation.from.chain}->${operation.to.chain}:${operation.token.amount}:${operation.address}:${operation.to.address}`

    const timestamp = Date.now().toString()
    const randomSuffix = randomBytes(8).toString("hex")

    // Hash to create clean, fixed-length bridge ID
    const bridgeData = `${operationData}:${timestamp}:${randomSuffix}`
    return `bridge_${Hashing.sha256(bridgeData).substring(0, 16)}`
}

/**
 * Parses the operation to get the right compiled operation content using deployed tank addresses
 * @param operation Native bridge operation from client
 * @param bridgeId Unique bridge identifier for this operation
 * @returns The compiled operation content with tank data and bridge ID
 */
async function parseOperation(
    operation: NativeBridgeOperation,
): Promise<CompiledContent> {
    const fromChainKey = operation.from.chain

    let tankData: SolanaTankData | EVMTankData = null

    if (
        typeof operation.from.chain === "string" &&
        operation.from.chain.startsWith("evm")
    ) {
        tankData = await parseEVMTankOperation(fromChainKey, operation)
    } else if (operation.from.chain.startsWith("solana")) {
        tankData = await parseSolanaTankOperation(fromChainKey, operation)
    } else {
        throw new Error(`Unsupported source chain: ${operation.from.chain}`)
    }

    const lastBlockNumber = await Chain.getLastBlockNumber()

    return {
        operation,
        tankData,
        // REVIEW: Approximate duration of the operation in blocks
        // i.e. Current block number + duration of the operation in blocks
        validUntil:
            lastBlockNumber +
            getSharedState.bridgeOperationExpiry / getSharedState.block_time,
    }
}

/**
 * Parse EVM tank operation using deployed tank address
 *
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

    const contractAddress = JsonConfig.getContractAddress(
        operation.token.name,
        chainKey,
    )
    if (!contractAddress) {
        throw new Error(`No deployed tank found for chain: ${chainKey}`)
    }

    // INFO: Make sure the token address matches the deployed tank address
    if (operation.token.address != contractAddress) {
        throw new Error(
            `Stablecoin contract address mismatch for ${operation.token.name} on ${chainKey}`,
        )
    }

    return {
        type: "evm",
        tankAddress: tankConfig.address,
        amountToDeposit: parseAmount(operation.token.amount, 6n),
        breakdown: {
            bridgeAmount: operation.token.amount,
            bridgeFee: "0",
        },
        abi: JSON.stringify(EvmLiquidityTankABI),
        feeBps: 0,
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
    // TODO: Replace with actual treasury program address once SolanaAddressManagement is implemented
    return {
        type: "solana",
        tankAddress: "0x0000000000000000000000000000000000000000", // Temporary - will be treasury program address
        amountToDeposit: parseAmount(operation.token.amount, 6n),
        feeBps: 0,
        breakdown: {
            bridgeAmount: operation.token.amount,
            bridgeFee: "0",
        },
    }
}
