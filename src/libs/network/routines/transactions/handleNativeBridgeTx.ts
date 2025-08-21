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

        // Step 6: Validate compiled operation signature
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
