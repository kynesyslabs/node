import log from "src/utilities/logger"
import Hashing from "@/libs/crypto/hashing"
import Chain from "@/libs/blockchain/chain"
import { NativeBridgeTransaction } from "@kynesyslabs/demosdk/types"
import { NativeBridge, validateChain } from "@kynesyslabs/demosdk/bridge"
import { hexToUint8Array, ucrypto } from "@kynesyslabs/demosdk/encryption"
import { EVMSmartContractManagement } from "@/features/bridges/native"

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

        const {
            operation: compiledOperation,
            txHash,
            bridgeId,
        } = tx.content.data[1]

        if (!compiledOperation?.content?.operation) {
            log.error(
                `${fname} Invalid compiled operation: missing operation data`,
            )
            return {
                success: false,
                message: "Invalid compiled operation: missing operation data",
            }
        }

        if (!bridgeId) {
            log.error(
                `${fname} Missing bridgeId: Bridge ID is required for operation tracking`,
            )
            return {
                success: false,
                message:
                    "Missing bridgeId: Bridge ID is required for operation tracking",
            }
        }

        // INFO: Validate bridge ID
        const bridge = new NativeBridge(null, null as any)
        const expectedBridgeId = bridge.generateBridgeId(
            compiledOperation.content.operation,
            txHash,
        )

        if (expectedBridgeId !== bridgeId) {
            log.error(
                `${fname} Bridge ID mismatch: expected=${expectedBridgeId}, got=${bridgeId}`,
            )
            return {
                success: false,
                error: "Bridge ID mismatch",
            }
        }

        // INFO: Verify bridgeId is not already executed
        const tankMan = EVMSmartContractManagement.getInstance()
        const bridgeStatus = await tankMan.validateBridgeId(
            bridgeId,
            compiledOperation.content.operation.to.chain,
        )
        if (!bridgeStatus.valid) {
            log.error(`${fname} Bridge ID already executed: ${bridgeId}`)
            return {
                success: false,
                error: bridgeStatus.message,
            }
        }

        // SECTION: Verify the deposit transaction
        const evm = tankMan.getTankConfig(
            compiledOperation.content.operation.from.chain,
        ).evmInstance

        // INFO: Get the deposit tx receipt
        const depositReceipt = await evm.provider.getTransactionReceipt(txHash)

        if (!depositReceipt) {
            log.error(
                `${fname} Deposit receipt not found for txHash: ${txHash}`,
            )
            return {
                success: false,
                error: "Deposit receipt not found",
            }
        }

        // INFO: Verify the deposit transaction (again)
        // const bridge = new NativeBridge(null, evm as any)
        bridge.verifyDepositTx(
            depositReceipt as any,
            {
                response: compiledOperation,
            } as any,
        )

        // // Validate bridge ID matches the one in compiled operation
        // if (compiledOperation.content.bridgeId !== bridgeId) {
        //     log.error(
        //         `${fname} Bridge ID mismatch: transaction=${bridgeId}, compiled=${compiledOperation.content.bridgeId}`,
        //     )
        //     return {
        //         success: false,
        //         message:
        //             "Bridge ID mismatch between transaction and compiled operation",
        //     }
        // }

        // Step 3: Validate the bridge operation using SDK methods
        log.info(`${fname} Validating bridge operation chains...`)

        const operation = compiledOperation.content.operation

        // Validate origin chain
        try {
            validateChain(operation.from.chain)
        } catch (error) {
            log.error(`${fname} Invalid origin chain: ${error}`)
            return {
                success: false,
                error: error.toString(),
            }
        }

        // Validate destination chain
        try {
            validateChain(operation.to.chain)
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

        if (!compiledOperation.content.tankData.tankAddress) {
            log.error(
                `${fname} EVM tank contract address is placeholder - contract not deployed`,
            )
            return {
                success: false,
                error: "EVM tank contract address not found in compiled operation",
            }
        }

        if (
            compiledOperation.content.tankData.tankAddress.includes(
                "0000000000",
            )
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

        // REVIEW: With operations now happening linearly, do we still need this?
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

        // // Step 6: Check for gasless bridge operation
        // log.info(`${fname} Checking for gasless bridge operation...`)
        // const isGaslessOperation = await detectGaslessOperation(
        //     compiledOperation,
        //     tx,
        // )

        // if (isGaslessOperation) {
        //     log.info(
        //         `${fname} Detected gasless bridge operation, validating user signature...`,
        //     )
        //     const gaslessValidation = await validateGaslessOperation(
        //         compiledOperation,
        //         tx,
        //     )
        //     if (!gaslessValidation.valid) {
        //         log.error(
        //             `${fname} Gasless operation validation failed: ${gaslessValidation.error}`,
        //         )
        //         return {
        //             success: false,
        //             error: gaslessValidation.error,
        //         }
        //     }
        //     log.info(`${fname} ✅ Gasless operation validated successfully`)
        // }

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

        log.info(
            `${fname} ✅ Native bridge transaction validation successful for bridge ID: ${bridgeId}`,
        )

        // NOTE: Mempool integration is handled by endpointHandlers.ts line 386-450
        // Bridge ID flows through mempool with the transaction - no separate storage needed

        return {
            success: true,
            message: `Native bridge transaction validation successful for bridge ID: ${bridgeId}`,
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
