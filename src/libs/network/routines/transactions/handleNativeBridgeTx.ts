import { bridge } from "@kynesyslabs/demosdk"
import { NativeBridgeTransaction } from "@kynesyslabs/demosdk/types"
import TxUtils from "../../../blockchain/transaction"
import Chain from "../../../blockchain/chain"
import log from "src/utilities/logger"
import { hexToUint8Array, ucrypto } from "@kynesyslabs/demosdk/encryption"
import Hashing from "../../../crypto/hashing"
import { validateChain } from "@kynesyslabs/demosdk/bridge"

/**
 * Handles the native bridge transaction (called by the endpoint handler)
 * @param tx The native bridge transaction to handle
 *
 * @returns The hash of the transaction where the bridge operation is set to be executed
 */
export default async function handleNativeBridgeTx(
    tx: NativeBridgeTransaction,
): Promise<{
    success: boolean
    message?: string
    error?: string
}> {
    const fname = "[handleNativeBridgeTx]"
    log.info(`${fname} Processing native bridge transaction: ${tx.hash}`)

    try {
        if (tx.content.data[0] !== "nativeBridge") {
            log.error(
                `${fname} Invalid transaction data type: expected 'nativeBridge', got '${tx.content.data[0]}'`,
            )
            return {
                success: false,
                message: "Invalid transaction data type",
            }
        }

        const compiledOperation = tx.content
            .data[1] as bridge.NativeBridgeOperationCompiled
        if (!compiledOperation?.content?.operation) {
            log.error(
                `${fname} Invalid compiled operation: missing operation data`,
            )
            return {
                success: false,
                message: "Invalid compiled operation: missing operation data",
            }
        }

        // Step 3: Validate the bridge operation using SDK methods
        log.info(`${fname} Validating bridge operation chains...`)

        const operation = compiledOperation.content.operation

        // Validate origin chain
        try {
            validateChain(operation.from.chain, true)
        } catch (error) {
            log.error(`${fname} Invalid origin chain: ${error}`)
            return {
                success: false,
                error: error.toString(),
            }
        }

        // Validate destination chain
        try {
            validateChain(operation.to.chain, false)
        } catch (error) {
            log.error(`${fname} Invalid destination chain: ${error}`)
            return {
                success: false,
                error: error.toString(),
            }
        }

        // Step 4: Validate compiled operation specific data
        log.info(`${fname} Validating tank addresses and timing...`)

        // Check tank addresses based on chain type
        // EVM chain - check contract address

        if (!compiledOperation.content.tankData.address) {
            log.error(
                `${fname} EVM tank contract address is placeholder - contract not deployed`,
            )
            return {
                success: false,
                error: "EVM tank contract address not found in compiled operation",
            }
        }

        if (
            compiledOperation.content.tankData.address ===
            "0x0000000000000000000000000000000000000000"
        ) {
            log.error(
                `${fname} EVM tank contract address is placeholder - contract not deployed`,
            )
            return {
                success: false,
                error: "EVM tank contract address is placeholder - contract not deployed",
            }
        }

        // Step 5: Validate timing (validUntil block check)
        log.info(`${fname} Validating operation timing...`)

        const currentBlockNumber = await Chain.getLastBlockNumber()
        if (compiledOperation.content.validUntil <= currentBlockNumber) {
            log.error(
                `${fname} Operation has expired: validUntil=${compiledOperation.content.validUntil}, currentBlock=${currentBlockNumber}`,
            )
            return {
                success: false,
                error: `Operation has expired: validUntil=${compiledOperation.content.validUntil}, currentBlock=${currentBlockNumber}`,
            }
        }

        // Step 6: Check for gasless bridge operation
        log.info(`${fname} Checking for gasless bridge operation...`)
        const isGaslessOperation = await detectGaslessOperation(compiledOperation, tx)

        if (isGaslessOperation) {
            log.info(`${fname} Detected gasless bridge operation, validating user signature...`)
            const gaslessValidation = await validateGaslessOperation(compiledOperation, tx)
            if (!gaslessValidation.valid) {
                log.error(`${fname} Gasless operation validation failed: ${gaslessValidation.error}`)
                return {
                    success: false,
                    error: gaslessValidation.error,
                }
            }
            log.info(`${fname} ✅ Gasless operation validated successfully`)
        }

        // Step 7: Validate compiled operation signature
        // REVIEW: This might be redundant since transaction signature already protects against tampering
        log.info(`${fname} Validating compiled operation signature...`)

        if (!compiledOperation.signature || !compiledOperation.rpcPublicKey) {
            log.error(
                `${fname} Missing signature or RPC public key in compiled operation`,
            )
            return null
        }

        // Verify the node's signature on the compiled operation content
        try {
            const contentHash = Hashing.sha256(
                JSON.stringify(compiledOperation.content),
            )
            const signatureValid = await ucrypto.verify({
                algorithm: compiledOperation.signature.type,
                message: new TextEncoder().encode(contentHash),
                publicKey: hexToUint8Array(compiledOperation.rpcPublicKey),
                signature: hexToUint8Array(compiledOperation.signature.data),
            })

            if (!signatureValid) {
                log.error(
                    `${fname} Invalid compiled operation signature from node: ${compiledOperation.rpcPublicKey}`,
                )
                return {
                    success: false,
                    error: `Invalid compiled operation signature from node: ${compiledOperation.rpcPublicKey}`,
                }
            }
        } catch (error) {
            log.error(
                `${fname} Error verifying compiled operation signature: ${error}`,
            )
            return {
                success: false,
                error: `Error verifying compiled operation signature: ${error.toString()}`,
            }
        }

        log.info(`${fname} ✅ Native bridge transaction validation successful`)

        // NOTE: Mempool integration is handled by endpointHandlers.ts line 386-450
        // If we return tx.hash (not null), the transaction will be added to mempool automatically

        return {
            success: true,
            message: "Native bridge transaction validation successful",
        }
    } catch (error) {
        log.error(
            `${fname} Error processing native bridge transaction: ${error}`,
        )
        return {
            success: false,
            error: `Error processing native bridge transaction: ${error.toString()}`,
        }
    }
}

/**
 * Detect if this is a gasless bridge operation
 * @param compiledOperation Compiled bridge operation
 * @param tx Native bridge transaction
 * @returns True if gasless operation detected
 */
async function detectGaslessOperation(
    compiledOperation: bridge.NativeBridgeOperationCompiled,
    tx: NativeBridgeTransaction,
): Promise<boolean> {
    const fname = "[detectGaslessOperation]"
    
    try {
        // Check for gasless flag in compiled operation
        if ((compiledOperation.content as any).gasless === true) {
            log.info(`${fname} Gasless flag detected in compiled operation`)
            return true
        }
        
        // Check for gasless user signature in transaction content
        if ((tx.content as any).userSignature) {
            log.info(`${fname} User signature detected in transaction content`)
            return true
        }
        
        // Check for gasless specific data fields
        if ((compiledOperation.content as any).userNonce !== undefined) {
            log.info(`${fname} User nonce detected in compiled operation`)
            return true
        }
        
        return false
    } catch (error) {
        log.warning(`${fname} Error detecting gasless operation: ${error}`)
        return false
    }
}

/**
 * Validate gasless bridge operation signatures and parameters
 * @param compiledOperation Compiled bridge operation
 * @param tx Native bridge transaction
 * @returns Validation result
 */
async function validateGaslessOperation(
    compiledOperation: bridge.NativeBridgeOperationCompiled,
    tx: NativeBridgeTransaction,
): Promise<{ valid: boolean; error?: string }> {
    const fname = "[validateGaslessOperation]"
    
    try {
        const operation = compiledOperation.content.operation
        const gaslessData = compiledOperation.content as any
        const txContent = tx.content as any
        
        // Extract gasless operation data
        const userSignature = txContent.userSignature || gaslessData.userSignature
        const userNonce = gaslessData.userNonce
        const userAddress = operation.from.address
        
        if (!userSignature) {
            return {
                valid: false,
                error: "Missing user signature for gasless operation",
            }
        }
        
        if (userNonce === undefined || userNonce === null) {
            return {
                valid: false,
                error: "Missing user nonce for gasless operation",
            }
        }
        
        // Validate user signature for bridge operation authorization
        const messageToSign = Hashing.sha256(JSON.stringify({
            action: "LIQUIDITY_TANK_BRIDGE",
            user: userAddress,
            nonce: userNonce,
            originChain: operation.from.chain,
            destChain: operation.to.chain,
            token: operation.token.address,
            recipient: operation.to.address,
            amount: operation.token.amount,
            bridgeFeeBps: gaslessData.bridgeFeeBps || 0,
        }))
        
        const signatureValid = await ucrypto.verify({
            algorithm: "ed25519", // TODO: Support secp256k1 as well
            message: new TextEncoder().encode(messageToSign),
            publicKey: hexToUint8Array(userAddress), // Assuming user address is their public key
            signature: hexToUint8Array(userSignature),
        })
        
        if (!signatureValid) {
            return {
                valid: false,
                error: `Invalid user signature for gasless operation from: ${userAddress}`,
            }
        }
        
        // Validate nonce to prevent replay attacks
        // TODO: Implement nonce checking against used nonces storage
        log.info(`${fname} User signature validated for gasless operation - user: ${userAddress}, nonce: ${userNonce}`)
        
        return { valid: true }
        
    } catch (error) {
        return {
            valid: false,
            error: `Error validating gasless operation: ${error.toString()}`,
        }
    }
}
