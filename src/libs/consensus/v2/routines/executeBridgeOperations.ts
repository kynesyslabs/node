import { Transaction } from "@kynesyslabs/demosdk/types"
import log from "@/utilities/logger"
import SecretaryManager from "../types/secretaryManager"
import { NativeBridgeOperationCompiled } from "@kynesyslabs/demosdk/bridge"
import { EVMSmartContractManagement } from "@/features/bridges/native/EVMSmartContractManagement"
import { getSharedState } from "@/utilities/sharedState"

export default async function executeBridgeOperations(
    bridgeTxs: Transaction[],
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
    // const nativeBridgeOperations: NativeBridgeTransaction[] =
    //     await Mempool.getNativeBridgeTransactions(blockNumber)

    log.info(
        `${fname} Found ${bridgeTxs.length} native bridge transactions in block ${blockNumber}`,
    )

    if (bridgeTxs.length > 0) {
        log.debug(
            `${fname} Native bridge operations:` +
                JSON.stringify(bridgeTxs, null, 2),
        )
    }

    // Initialize EVM tank management system
    const evmTankManager = EVMSmartContractManagement.getInstance()
    if (!evmTankManager.isReady()) {
        log.error(`${fname} EVM tank management system not initialized`)
        process.exit(1)
    }

    // Process each native bridge operation
    const successful: string[] = []
    const failed: string[] = []

    // for (const bridgeTx of bridgeTxs) {
    //     await processBridgeTx(bridgeTx)
    // }
    const results = await Promise.all(
        bridgeTxs.map(async bridgeTx => {
            return await processBridgeTx(bridgeTx)
        }),
    )

    for (const result of results) {
        if (result.success) {
            successful.push(result.txHash)
        } else {
            failed.push(result.txHash)
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

async function processBridgeTx(bridgeTx: Transaction): Promise<{
    txHash: string
    success: boolean
    error?: string
    proposalId?: string
}> {
    const fname = "[processBridgeTx]"
    const evmTankManager = EVMSmartContractManagement.getInstance()

    // Extract BridgeOperationCompiled from transaction
    const compiled = bridgeTx.content.data[1] as NativeBridgeOperationCompiled
    const operation = compiled.content.operation
    const txHash = compiled.content.txHash
    const destination = `${operation.from.chain}.${operation.from.subchain}`
    
    // Detect if this is a gasless operation
    const isGasless = detectGaslessOperation(compiled, bridgeTx)
    const gaslessData = isGasless ? extractGaslessData(compiled, bridgeTx) : null

    log.debug(
        `${fname} Processing bridge operation: ${operation.from.chain} -> ${operation.to.chain} (gasless: ${isGasless})`,
    )

    const result = {
        txHash: bridgeTx.hash,
        success: false,
    }

    // Step 1 - Verify deposit on source chain
    // let depositVerified = false
    if (operation.from.chain.startsWith("evm")) {
        // Verify deposit using existing tank management
        const depositResult = await evmTankManager.verifyDeposit(
            destination,
            txHash,
            operation.token.amount,
            operation.from.address,
        )

        if (!depositResult.valid) {
            log.warning(
                `${fname} Deposit verification failed on ${operation.from.chain}.${operation.from.subchain}`,
            )
            return {
                ...result,
                error: "Deposit verification failed",
            }
        }
    } else {
        // SOLANA not implemented yet - skip for now
        log.info(`${fname} Solana operations not yet supported, skipping`)
        return {
            ...result,
            error: "Solana operations not yet supported",
        }
    }

    // Step 2 - Check tank liquidity on destination
    if (operation.to.chain.startsWith("evm")) {
        if (!evmTankManager.getTankConfig(destination)) {
            log.error(`${fname} Unsupported destination chain: ${destination}`)
            process.exit(1)
        }

        const balance = await evmTankManager.getUSDCBalance(destination)
        const balanceNum = parseInt(balance)
        const requiredAmount = parseInt(operation.token.amount.toString())

        if (balanceNum >= requiredAmount) {
            log.error(
                `${fname} Insufficient liquidity on ${destination}: ${balance} < ${requiredAmount}`,
            )
            process.exit(1)
            return {
                ...result,
                error: "Insufficient liquidity on destination chain",
            }
        }
    } else {
        // TODO SOLANA not implemented yet
        // For now, just log and skip
        log.info(`${fname} Solana destinations not yet supported`)
        return {
            ...result,
            error: "Solana destinations not yet supported",
        }
    }

    // Step 3 - Execute withdrawal on destination chain
    if (operation.to.chain.startsWith("evm")) {
        // TODO: Get actual shard signing keys from SecretaryManager
        // For now, using placeholder - this needs proper key management
        const shardSigningKeys = getShardSigningKeys()

        if (shardSigningKeys.length === 0) {
            throw new Error(
                "No shard signing keys available for withdrawal execution",
            )
        }

        let proposalId: string

        if (isGasless && gaslessData) {
            // Execute gasless withdrawal using meta-transaction
            log.info(`${fname} Executing gasless withdrawal on ${destination}`)
            
            // Check gas subsidy pool balance before executing
            const subsidyBalance = await checkGasSubsidyBalance(destination)
            if (!subsidyBalance.sufficient) {
                log.error(`${fname} Insufficient gas subsidy balance on ${destination}: ${subsidyBalance.balance}`)
                return {
                    ...result,
                    error: `Insufficient gas subsidy balance: ${subsidyBalance.balance}`
                }
            }

            proposalId = await evmTankManager.executeGaslessWithdrawal(
                destination,
                operation.to.address,
                operation.token.amount.toString(),
                shardSigningKeys,
                gaslessData.userSignature,
                gaslessData.userNonce
            )

            // Track gas subsidy usage
            await trackGasSubsidyUsage(destination, proposalId, "withdrawal")
            log.info(`${fname} ✅ Gasless withdrawal executed on ${destination}: ${proposalId}`)
        } else {
            // Execute regular withdrawal using multisig
            log.info(`${fname} Executing regular withdrawal on ${destination}`)
            proposalId = await evmTankManager.executeWithdrawal(
                destination,
                operation.to.address,
                operation.token.amount.toString(),
                shardSigningKeys,
            )
            log.info(`${fname} ✅ Regular withdrawal executed on ${destination}: ${proposalId}`)
        }

        return {
            ...result,
            success: true,
            proposalId: proposalId,
        }
    }

    return {
        ...result,
        error: "Unsupported chain type",
    }
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

/**
 * Detect if this is a gasless bridge operation
 * @param compiled Compiled bridge operation
 * @param bridgeTx Bridge transaction
 * @returns True if gasless operation detected
 */
function detectGaslessOperation(
    compiled: NativeBridgeOperationCompiled,
    bridgeTx: Transaction
): boolean {
    const fname = "[detectGaslessOperation]"
    
    try {
        // Check for gasless flag in compiled operation
        if ((compiled.content as any).gasless === true) {
            log.debug(`${fname} Gasless flag detected in compiled operation`)
            return true
        }
        
        // Check for gasless user signature in transaction content
        if ((bridgeTx.content as any).userSignature) {
            log.debug(`${fname} User signature detected in transaction content`)
            return true
        }
        
        // Check for gasless specific data fields
        if ((compiled.content as any).userNonce !== undefined) {
            log.debug(`${fname} User nonce detected in compiled operation`)
            return true
        }
        
        return false
    } catch (error) {
        log.warning(`${fname} Error detecting gasless operation: ${error}`)
        return false
    }
}

/**
 * Extract gasless operation data from compiled operation and transaction
 * @param compiled Compiled bridge operation
 * @param bridgeTx Bridge transaction
 * @returns Gasless operation data
 */
function extractGaslessData(
    compiled: NativeBridgeOperationCompiled,
    bridgeTx: Transaction
): {
    userSignature: string
    userNonce: number
    bridgeFeeBps?: number
} | null {
    const fname = "[extractGaslessData]"
    
    try {
        const gaslessData = compiled.content as any
        const txContent = bridgeTx.content as any
        
        // Extract user signature from transaction or compiled operation
        const userSignature = txContent.userSignature || gaslessData.userSignature
        const userNonce = gaslessData.userNonce
        const bridgeFeeBps = gaslessData.bridgeFeeBps
        
        if (!userSignature || userNonce === undefined) {
            log.error(`${fname} Missing required gasless data - signature: ${!!userSignature}, nonce: ${userNonce}`)
            return null
        }
        
        return {
            userSignature,
            userNonce,
            bridgeFeeBps
        }
    } catch (error) {
        log.error(`${fname} Error extracting gasless data: ${error}`)
        return null
    }
}

/**
 * Check gas subsidy pool balance for gasless operations
 * @param chainKey Chain key to check
 * @returns Subsidy balance status
 */
async function checkGasSubsidyBalance(chainKey: string): Promise<{
    sufficient: boolean
    balance: string
    threshold: string
}> {
    const fname = "[checkGasSubsidyBalance]"
    
    try {
        const evmTankManager = EVMSmartContractManagement.getInstance()
        
        // Get current subsidy pool balance from tank contract
        // TODO: Implement getGasSubsidyBalance method in EVMSmartContractManagement
        // For now, assume sufficient balance - this needs proper implementation
        const balance = "1000000000000000000" // 1 ETH placeholder
        const threshold = "100000000000000000" // 0.1 ETH threshold
        
        const balanceNum = BigInt(balance)
        const thresholdNum = BigInt(threshold)
        const sufficient = balanceNum >= thresholdNum
        
        if (!sufficient) {
            log.warning(`${fname} Gas subsidy pool running low on ${chainKey}: ${balance} < ${threshold}`)
        } else {
            log.debug(`${fname} Gas subsidy pool balance sufficient on ${chainKey}: ${balance}`)
        }
        
        return {
            sufficient,
            balance,
            threshold
        }
    } catch (error) {
        log.error(`${fname} Error checking gas subsidy balance: ${error}`)
        return {
            sufficient: false,
            balance: "0",
            threshold: "100000000000000000"
        }
    }
}

/**
 * Track gas subsidy usage for monitoring
 * @param chainKey Chain key where gas was consumed
 * @param proposalId Proposal ID of the operation
 * @param operationType Type of operation (withdrawal, deposit, etc.)
 */
async function trackGasSubsidyUsage(
    chainKey: string,
    proposalId: string,
    operationType: string
): Promise<void> {
    const fname = "[trackGasSubsidyUsage]"
    
    try {
        // TODO: Implement proper gas usage tracking
        // This should store usage in database or monitoring system
        log.info(`${fname} Gas subsidy used - Chain: ${chainKey}, Proposal: ${proposalId}, Type: ${operationType}`)
        
        // TODO: Implement the following:
        // 1. Calculate actual gas consumed from transaction receipt
        // 2. Store usage in database with timestamp
        // 3. Update daily/weekly usage statistics
        // 4. Trigger alerts if usage exceeds thresholds
        
        // Example monitoring alert check:
        // const dailyUsage = await getDailyGasUsage(chainKey)
        // const dailyLimit = getGasUsageLimit(chainKey)
        // if (dailyUsage > dailyLimit * 0.8) {
        //     await sendGasUsageAlert(chainKey, dailyUsage, dailyLimit)
        // }
        
    } catch (error) {
        log.error(`${fname} Error tracking gas subsidy usage: ${error}`)
        // Don't throw - tracking failure shouldn't stop the operation
    }
}
