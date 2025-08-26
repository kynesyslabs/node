import { EVMSmartContractManagement } from "@/features/bridges/native/EVMSmartContractManagement"
import log from "src/utilities/logger"
import { ucrypto, hexToUint8Array } from "@kynesyslabs/demosdk/encryption"
import Hashing from "../../../crypto/hashing"

/**
 * Handles gasless bridge initiation requests
 * @param params Bridge operation parameters with user signature
 * @returns Operation ID and tank address for gasless bridge
 */
export async function handleInitiateGaslessBridge(params: {
    user: string
    signature: string
    nonce: number
    originChain: string
    destChain: string
    token: string
    recipient: string
    amount: string
    bridgeFeeBps: number
}): Promise<{
    success: boolean
    tankAddress?: string
    operationId?: string
    message?: string
    error?: string
}> {
    const fname = "[handleInitiateGaslessBridge]"
    log.info(`${fname} Processing gasless bridge initiation for user: ${params.user}`)

    try {
        // Validate signature for gasless bridge authorization
        const messageHash = Hashing.sha256(JSON.stringify({
            action: "LIQUIDITY_TANK_BRIDGE",
            user: params.user,
            nonce: params.nonce,
            originChain: params.originChain,
            destChain: params.destChain,
            token: params.token,
            recipient: params.recipient,
            amount: params.amount,
            bridgeFeeBps: params.bridgeFeeBps
        }))

        const signatureValid = await ucrypto.verify({
            algorithm: "ed25519", // TODO: Support secp256k1 as well
            message: new TextEncoder().encode(messageHash),
            publicKey: hexToUint8Array(params.user), // Assuming user is their public key
            signature: hexToUint8Array(params.signature)
        })

        if (!signatureValid) {
            log.error(`${fname} Invalid signature from user: ${params.user}`)
            return {
                success: false,
                error: "Invalid signature for gasless bridge operation"
            }
        }

        // Get EVM tank manager instance
        const evmTankManager = EVMSmartContractManagement.getInstance()
        if (!evmTankManager.isReady()) {
            log.error(`${fname} EVM tank management system not initialized`)
            return {
                success: false,
                error: "Bridge system not ready"
            }
        }

        // Get tank address for the origin chain
        const chainKey = `${params.originChain.toLowerCase()}.${process.env.NODE_ENV === 'production' ? 'mainnet' : 'sepolia'}`
        const tankConfig = evmTankManager.getTankConfig(chainKey)
        
        if (!tankConfig) {
            log.error(`${fname} No tank configuration found for chain: ${chainKey}`)
            return {
                success: false,
                error: `Unsupported chain: ${params.originChain}`
            }
        }

        // Execute gasless bridge initiation using EVMSmartContractManagement
        const operationTxHash = await evmTankManager.initiateGaslessBridgeOperation(
            chainKey,
            {
                user: params.user,
                nonce: params.nonce,
                originChain: params.originChain,
                destChain: params.destChain,
                token: params.token,
                recipient: params.recipient,
                amount: params.amount,
                bridgeFeeBps: params.bridgeFeeBps
            },
            params.signature
        )

        log.info(`${fname} ✅ Gasless bridge operation initiated: ${operationTxHash}`)

        return {
            success: true,
            tankAddress: tankConfig.address,
            operationId: operationTxHash, // Use tx hash as operation ID
            message: "Gasless bridge operation initiated successfully"
        }

    } catch (error) {
        log.error(`${fname} Error processing gasless bridge initiation: ${error}`)
        return {
            success: false,
            error: `Error processing gasless bridge initiation: ${error.toString()}`
        }
    }
}

/**
 * Handles gasless deposit execution requests
 * @param params Deposit parameters with user signature
 * @returns Deposit confirmation
 */
export async function handleExecuteGaslessDeposit(params: {
    user: string
    signature: string
    nonce: number
    chainKey: string
    usdcAddress: string
    amount: string
}): Promise<{
    success: boolean
    txHash?: string
    message?: string
    error?: string
}> {
    const fname = "[handleExecuteGaslessDeposit]"
    log.info(`${fname} Processing gasless deposit for user: ${params.user}`)

    try {
        // Validate signature for gasless deposit authorization
        const messageHash = Hashing.sha256(JSON.stringify({
            action: "LIQUIDITY_TANK_DEPOSIT",
            user: params.user,
            nonce: params.nonce,
            usdcAddress: params.usdcAddress,
            amount: params.amount,
            chainKey: params.chainKey
        }))

        const signatureValid = await ucrypto.verify({
            algorithm: "ed25519", // TODO: Support secp256k1 as well
            message: new TextEncoder().encode(messageHash),
            publicKey: hexToUint8Array(params.user), // Assuming user is their public key
            signature: hexToUint8Array(params.signature)
        })

        if (!signatureValid) {
            log.error(`${fname} Invalid signature from user: ${params.user}`)
            return {
                success: false,
                error: "Invalid signature for gasless deposit"
            }
        }

        // Get EVM tank manager instance
        const evmTankManager = EVMSmartContractManagement.getInstance()
        if (!evmTankManager.isReady()) {
            log.error(`${fname} EVM tank management system not initialized`)
            return {
                success: false,
                error: "Bridge system not ready"
            }
        }

        // Execute gasless deposit using EVMSmartContractManagement
        const txHash = await evmTankManager.executeGaslessDeposit(
            params.chainKey,
            params.user,
            params.amount,
            params.signature,
            params.nonce
        )

        log.info(`${fname} ✅ Gasless deposit executed for user: ${params.user}`)

        return {
            success: true,
            message: "Gasless deposit executed successfully",
            txHash: txHash
        }

    } catch (error) {
        log.error(`${fname} Error processing gasless deposit: ${error}`)
        return {
            success: false,
            error: `Error processing gasless deposit: ${error.toString()}`
        }
    }
}