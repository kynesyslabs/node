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

    log.debug(
        `${fname} Processing bridge operation: ${operation.from.chain} -> ${operation.to.chain}`,
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

        // Execute withdrawal using existing tank management
        const proposalId = await evmTankManager.executeWithdrawal(
            destination,
            operation.to.address,
            operation.token.amount.toString(),
            shardSigningKeys,
        )

        log.info(
            `${fname} Withdrawal executed on ${destination}: ${proposalId}`,
        )
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
