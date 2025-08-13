import { bridge } from "@kynesyslabs/demosdk"
import { NativeBridgeTransaction } from "@kynesyslabs/demosdk/types"
import { NativeBridgeMethods } from "../../../../../../sdks/src/bridge" // FIXME: Once is published, use the package import
import TxUtils from "../../../blockchain/transaction"
import Chain from "../../../blockchain/chain"
import log from "src/utilities/logger"
import { hexToUint8Array, ucrypto } from "@kynesyslabs/demosdk/encryption"
import Hashing from "../../../crypto/hashing"

/**
 * Handles the native bridge transaction (called by the endpoint handler)
 * @param tx The native bridge transaction to handle
 *
 * @returns The hash of the transaction where the bridge operation is set to be executed
 */
export default async function handleNativeBridgeTx(
    tx: NativeBridgeTransaction,
): Promise<string | null> {
    const fname = "[handleNativeBridgeTx]"
    log.info(`${fname} Processing native bridge transaction: ${tx.hash}`)

    try {
        // Step 1: Validate transaction signature and coherence using battle-tested methods
        log.info(`${fname} Validating transaction signature and coherence...`)
        
        const isCoherent = TxUtils.isCoherent(tx)
        if (!isCoherent) {
            log.error(`${fname} Transaction is not coherent: ${tx.hash}`)
            return null
        }

        const signatureValid = TxUtils.validateSignature(tx)
        if (!signatureValid) {
            log.error(`${fname} Transaction signature is not valid: ${tx.hash}`)
            return null
        }

        // Step 2: Validate the compiled bridge operation structure
        log.info(`${fname} Validating compiled bridge operation...`)
        
        if (!tx.content.data || tx.content.data.length < 2) {
            log.error(`${fname} Invalid transaction data structure`)
            return null
        }

        if (tx.content.data[0] !== "nativeBridge") {
            log.error(`${fname} Invalid transaction data type: expected 'nativeBridge', got '${tx.content.data[0]}'`)
            return null
        }

        const compiledOperation = tx.content.data[1] as bridge.NativeBridgeOperationCompiled
        if (!compiledOperation?.content?.operation) {
            log.error(`${fname} Invalid compiled operation: missing operation data`)
            return null
        }

        // Step 3: Validate the bridge operation using SDK methods
        log.info(`${fname} Validating bridge operation chains...`)
        
        const operation = compiledOperation.content.operation
        
        // Validate origin chain
        try {
            NativeBridgeMethods.validateChain(
                operation.originChain,
                operation.originChainType,
                true, // isOrigin
            )
        } catch (error) {
            log.error(`${fname} Invalid origin chain: ${error}`)
            return null
        }

        // Validate destination chain  
        try {
            NativeBridgeMethods.validateChain(
                operation.destinationChain,
                operation.destinationChainType,
                false, // isOrigin
            )
        } catch (error) {
            log.error(`${fname} Invalid destination chain: ${error}`)
            return null
        }

        // Step 4: Validate compiled operation specific data
        log.info(`${fname} Validating tank addresses and timing...`)
        
        // Check tank addresses based on chain type
        if ("contractAddress" in compiledOperation.content) {
            // EVM chain - check contract address
            if (compiledOperation.content.contractAddress === "0x0000000000000000000000000000000000000000") {
                log.error(`${fname} EVM tank contract address is placeholder - contract not deployed`)
                return null
            }
        } else if ("solanaAddress" in compiledOperation.content) {
            // Solana chain - check solana address
            if (compiledOperation.content.solanaAddress === "0x0000000000000000000000000000000000000000" ||
                compiledOperation.content.solanaAddress === "") {
                log.error(`${fname} Solana tank address is placeholder - program not deployed`)
                return null
            }
        } else {
            log.error(`${fname} Compiled operation missing tank address for origin chain`)
            return null
        }

        // Step 5: Validate timing (validUntil block check)
        log.info(`${fname} Validating operation timing...`)
        
        const currentBlockNumber = await Chain.getLastBlockNumber()
        if (compiledOperation.content.validUntil <= currentBlockNumber) {
            log.error(`${fname} Operation has expired: validUntil=${compiledOperation.content.validUntil}, currentBlock=${currentBlockNumber}`)
            return null
        }

        // Step 6: Validate compiled operation signature
        // REVIEW: This might be redundant since transaction signature already protects against tampering
        log.info(`${fname} Validating compiled operation signature...`)
        
        if (!compiledOperation.signature || !compiledOperation.rpc) {
            log.error(`${fname} Missing signature or RPC public key in compiled operation`)
            return null
        }

        // Verify the node's signature on the compiled operation content
        try {
            const contentHash = Hashing.sha256(JSON.stringify(compiledOperation.content))
            const signatureValid = await ucrypto.verify({
                algorithm: "ed25519", // Assuming node uses ed25519
                message: new TextEncoder().encode(contentHash),
                publicKey: hexToUint8Array(compiledOperation.rpc),
                signature: hexToUint8Array(compiledOperation.signature),
            })

            if (!signatureValid) {
                log.error(`${fname} Invalid compiled operation signature from node: ${compiledOperation.rpc}`)
                return null
            }
        } catch (error) {
            log.error(`${fname} Error verifying compiled operation signature: ${error}`)
            return null
        }

        log.info(`${fname} ✅ Native bridge transaction validation successful`)
        
        // NOTE: Mempool integration is handled by endpointHandlers.ts line 386-450
        // If we return tx.hash (not null), the transaction will be added to mempool automatically

        return tx.hash

    } catch (error) {
        log.error(`${fname} Error processing native bridge transaction: ${error}`)
        return null
    }
}
