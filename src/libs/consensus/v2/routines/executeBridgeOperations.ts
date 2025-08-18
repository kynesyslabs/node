import {
    Transaction,
    NativeBridgeTransaction,
} from "@kynesyslabs/demosdk/types"
import log from "@/utilities/logger"
import Mempool from "../../../blockchain/mempool_v2"
import SecretaryManager from "../types/secretaryManager"
import {
    BridgeOperation,
    BridgeOperationCompiled,
} from "node_modules/@kynesyslabs/demosdk/build/bridge/nativeBridgeTypes"
import { EVMSmartContractManagement } from "@/features/bridges/native/EVMSmartContractManagement"
import { JsonConfig } from "@/utilities/JsonConfig"
import { getSharedState } from "@/utilities/sharedState"

export default async function executeBridgeOperations(
    mempool: Transaction[],
): Promise<[string[], string[]]> {
    const fname = "[executeBridgeOperations]"
    log.info(`${fname} Processing bridge operations for consensus...`)

    // Get current block number for filtering
    const manager = SecretaryManager.getInstance()
    const blockNumber = manager.shard?.blockRef

    if (!blockNumber) {
        log.error(`${fname} No block reference found in secretary manager`)
        return [[], []]
    }

    // Efficiently get native bridge transactions from database
    const nativeBridgeOperations: NativeBridgeTransaction[] =
        await Mempool.getNativeBridgeTransactions(blockNumber)

    log.info(
        `${fname} Found ${nativeBridgeOperations.length} native bridge transactions in block ${blockNumber}`,
    )

    if (nativeBridgeOperations.length > 0) {
        log.debug(
            `${fname} Native bridge operations:` +
                JSON.stringify(nativeBridgeOperations, null, 2),
        )
    }

    // Initialize EVM tank management system
    const evmTankManager = EVMSmartContractManagement.getInstance()
    if (!evmTankManager.isReady()) {
        const tankAddresses = JsonConfig.getTankAddresses()
        await evmTankManager.initialize(tankAddresses)
        log.info(`${fname} Initialized EVM tank management system`)
    }

    // Process each native bridge operation
    const successful: string[] = []
    const failed: string[] = []

    for (const bridgeTx of nativeBridgeOperations) {
        try {
            // Extract BridgeOperationCompiled from transaction
            const compiled = bridgeTx.content.data[1] as BridgeOperationCompiled
            const operation = compiled.content.operation

            log.debug(
                `${fname} Processing bridge operation: ${operation.originChain} -> ${operation.destinationChain}`,
            )

            // Step 1 - Verify deposit on source chain
            let depositVerified = false
            if (operation.originChainType === "EVM") {
                // Map chain name to chain key (e.g., "eth" -> "eth.sepolia")
                const originChainKey = getChainKeyFromName(
                    operation.originChain,
                )
                if (!originChainKey) {
                    throw new Error(
                        `Unsupported origin chain: ${operation.originChain}`,
                    )
                }

                // Verify deposit using existing tank management
                const depositResult = await evmTankManager.verifyDeposit(
                    originChainKey,
                    operation.txHash,
                    operation.amount.toString(),
                    operation.originAddress,
                )

                if (depositResult.valid) {
                    depositVerified = true
                    log.info(
                        `${fname} Deposit verified on ${originChainKey}: ${operation.amount}`,
                    )
                } else {
                    log.warning(
                        `${fname} Deposit verification failed on ${originChainKey}`,
                    )
                }
            } else {
                // SOLANA not implemented yet - skip for now
                log.info(
                    `${fname} Solana operations not yet supported, skipping`,
                )
                failed.push(bridgeTx.hash)
                continue
            }

            if (!depositVerified) {
                failed.push(bridgeTx.hash)
                continue
            }

            // Step 2 - Check tank liquidity on destination
            let sufficientLiquidity = false
            if (operation.destinationChainType === "EVM") {
                const destinationChainKey = getChainKeyFromName(
                    operation.destinationChain,
                )
                if (!destinationChainKey) {
                    throw new Error(
                        `Unsupported destination chain: ${operation.destinationChain}`,
                    )
                }

                const balance = await evmTankManager.getUSDCBalance(
                    destinationChainKey,
                )
                const balanceNum = parseInt(balance)
                const requiredAmount = parseInt(operation.amount.toString())

                if (balanceNum >= requiredAmount) {
                    sufficientLiquidity = true
                    log.info(
                        `${fname} Sufficient liquidity on ${destinationChainKey}: ${balance} >= ${requiredAmount}`,
                    )
                } else {
                    log.warning(
                        `${fname} Insufficient liquidity on ${destinationChainKey}: ${balance} < ${requiredAmount}`,
                    )
                }
            } else {
                // TODO SOLANA not implemented yet
                // For now, just log and skip
                log.info(`${fname} Solana destinations not yet supported`)
                failed.push(bridgeTx.hash)
                continue
            }

            if (!sufficientLiquidity) {
                failed.push(bridgeTx.hash)
                continue
            }

            // Step 3 - Execute withdrawal on destination chain
            if (operation.destinationChainType === "EVM") {
                const destinationChainKey = getChainKeyFromName(
                    operation.destinationChain,
                )

                // TODO: Get actual shard signing keys from SecretaryManager
                // For now, using placeholder - this needs proper key management
                const shardSigningKeys = getShardSigningKeys()

                if (shardSigningKeys.length === 0) {
                    throw new Error(
                        "No shard signing keys available for withdrawal execution",
                    )
                }

                // Execute withdrawal using existing tank management
                const proposalId = await evmTankManager.executeWithdrawal(
                    destinationChainKey,
                    operation.destinationAddress,
                    operation.amount.toString(),
                    shardSigningKeys,
                )

                log.info(
                    `${fname} Withdrawal executed on ${destinationChainKey}: ${proposalId}`,
                )
                successful.push(bridgeTx.hash)
            }
        } catch (error) {
            log.error(
                `${fname} Failed to process bridge operation ${bridgeTx.hash}: ${error}`,
            )
            failed.push(bridgeTx.hash)
        }
    }

    // TODO: Log summary of operations
    if (successful.length > 0) {
        log.info(
            `${fname} Successfully executed ${successful.length} bridge operations`,
        )
    }
    if (failed.length > 0) {
        log.warning(
            `${fname} Failed to execute ${failed.length} bridge operations`,
        )
    }

    return [successful, failed]
}

/**
 * Map chain name to chain key format used by tank management
 * @param chainName Chain name (e.g., "eth", "polygon")
 * @returns Chain key (e.g., "eth.sepolia") or null if unsupported
 */
function getChainKeyFromName(chainName: string): string | null {
    var chainNameMap: { [key: string]: string }
    // If we're in production, use the actual chain keys
    if (getSharedState.PROD) {
        chainNameMap = {
            eth: "eth.mainnet",
            polygon: "polygon.mainnet",
            bsc: "bsc.mainnet",
            arbitrum: "arbitrum.mainnet",
            base: "base.mainnet",
            optimism: "optimism.mainnet",
            avalanche: "avalanche.mainnet", // Assuming C-Chain
            SOLANA: "solana.mainnet", // Will be used when Solana is implemented
        }
        // If we're in development, use testnet chain keys
        // This allows us to test without needing real deployments
    } else {
        chainNameMap = {
            eth: "eth.sepolia",
            polygon: "polygon.amoy",
            bsc: "bsc.testnet",
            arbitrum: "arbitrum.sepolia",
            base: "base.sepolia",
            optimism: "optimism.sepolia",
            avalanche: "avalanche.fuji", // Assuming Fuji testnet
            SOLANA: "solana.devnet", // Will be used when Solana is implemented
        }
    }

    return chainNameMap[chainName] || null
}

/**
 * Get shard signing keys for multisig operations
 * TODO: Implement proper key management with SecretaryManager
 * @returns Array of private keys for shard signers
 */
function getShardSigningKeys(): string[] {
    // REVIEW: This needs proper implementation with actual shard key management
    // For now returning empty array - this will cause operations to fail
    // until proper key management is implemented

    // TODO: Get from SecretaryManager or environment variables
    // const manager = SecretaryManager.getInstance()
    // const shardKeys = manager.getShardSigningKeys()
    // return shardKeys

    return []
}
