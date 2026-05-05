import Mempool from "../../blockchain/mempool"
import isValidatorForNextBlock from "../../consensus/v2/routines/isValidator"
import getShard from "../../consensus/v2/routines/getShard"
import getCommonValidatorSeed from "../../consensus/v2/routines/getCommonValidatorSeed"
import { getSharedState } from "../../../utilities/sharedState"
import log from "../../../utilities/logger"
import { Peer, PeerManager } from "@/libs/peer"
import {
    RPCRequest,
    RPCResponse,
    SigningAlgorithm,
    ValidityData,
} from "@kynesyslabs/demosdk/types"
import {
    Hashing,
    hexToUint8Array,
    ucrypto,
} from "@kynesyslabs/demosdk/encryption"

import TxUtils from "../../blockchain/transaction"
import { Waiter } from "@/utilities/waiter"
import Block from "@/libs/blockchain/block"
import Chain from "@/libs/blockchain/chain"
import TxValidatorPool from "@/libs/blockchain/validation/txValidatorPool"

/**
 * DTR (Distributed Transaction Routing) Relay Retry Service
 *
 * Background service that continuously attempts to relay transactions from non-validator nodes
 * to validator nodes. Runs every 10 seconds on non-validator nodes in production mode.
 *
 * Key Features:
 * - Only runs on non-validator nodes when PROD=true
 * - Recalculates validator set only when block number changes (optimized)
 * - Tries all validators in random order for load balancing
 * - Removes successfully relayed transactions from local mempool
 * - Gives up after 10 failed attempts per transaction
 * - Manages ValidityData cache cleanup
 */
export class DTRManager {
    private static instance: DTRManager
    private isRunning = false
    private retryInterval: NodeJS.Timeout | null = null
    private retryAttempts = new Map<string, number>() // txHash -> attempt count
    private readonly maxRetryAttempts = 10
    private readonly retryIntervalMs = 10000 // 10 seconds
    // map of txhash to ValidityData
    public static validityDataCache = new Map<string, ValidityData>()

    // Optimization: only recalculate validators when block number changes
    private lastBlockNumber = 0
    private cachedValidators: any[] = []

    static getInstance(): DTRManager {
        if (!DTRManager.instance) {
            DTRManager.instance = new DTRManager()
        }
        return DTRManager.instance
    }

    static get poolSize(): number {
        return DTRManager.validityDataCache.size
    }

    static get isWaitingForBlock(): boolean {
        return Waiter.isWaiting(Waiter.keys.DTR_WAIT_FOR_BLOCK)
    }

    /**
     * Releases the DTR transaction relay waiter
     *
     * @param block - Block to use for the common validator seed.
     * If not provided, the last block will be used.
     */
    static async releaseDTRWaiter(block?: Block) {
        if (Waiter.isWaiting(Waiter.keys.DTR_WAIT_FOR_BLOCK)) {
            log.debug("[DTRManager] releasing DTR transaction relay waiter")
            const { commonValidatorSeed } = await getCommonValidatorSeed(block)
            Waiter.resolve(Waiter.keys.DTR_WAIT_FOR_BLOCK, commonValidatorSeed)
        }
    }

    /**
     * @deprecated
     *
     * Starts the background relay retry service
     * Only starts if not already running
     */
    start() {
        if (this.isRunning) return

        log.info(
            "[DTR RetryService] Service started - will retry every 10 seconds",
        )
        this.isRunning = true

        this.retryInterval = setInterval(() => {
            this.processMempool().catch(error => {
                log.error("[DTR RetryService] Error in retry cycle: " + error)
            })
        }, this.retryIntervalMs)
    }

    /**
     * @deprecated
     *
     * Stops the background relay retry service
     * Cleans up interval and resets state
     */
    stop() {
        if (!this.isRunning) return

        log.info("[DTR RetryService] Stopping relay service")
        this.isRunning = false

        if (this.retryInterval) {
            clearInterval(this.retryInterval)
            this.retryInterval = null
        }

        // Clean up state
        this.retryAttempts.clear()
        this.cachedValidators = []
        this.lastBlockNumber = 0
    }

    /**
     * @deprecated
     *
     * Main processing loop - runs every 10 seconds
     * Checks mempool for transactions that need relaying
     */
    private async processMempool() {
        try {
            // Only run in production mode
            if (!getSharedState.PROD) {
                return
            }

            // Only run after sync is complete
            if (!getSharedState.syncStatus) {
                return
            }

            // Only run on non-validator nodes
            if (await isValidatorForNextBlock()) {
                return
            }

            // Get our entire mempool
            const mempool = await Mempool.getMempool()

            if (mempool.length === 0) {
                return
            }

            log.info(
                `[DTR RetryService] Processing ${mempool.length} transactions in mempool`,
            )

            // Get validators (only recalculate if block number changed)
            const availableValidators = await this.getValidatorsOptimized()

            if (availableValidators.length === 0) {
                log.warn("[DTR RetryService] No validators available for relay")
                return
            }

            log.debug(
                `[DTR RetryService] Found ${availableValidators.length} available validators`,
            )

            // Process each transaction in mempool
            for (const tx of mempool) {
                await this.tryRelayTransaction(tx, availableValidators)
            }
        } catch (error) {
            log.error("[DTR RetryService] Error processing mempool: " + error)
        }
    }

    /**
     * Optimized validator retrieval - only recalculates when block number changes
     * @returns Array of available validators in random order
     */
    private async getValidatorsOptimized(): Promise<any[]> {
        const currentBlockNumber = getSharedState.lastBlockNumber

        // Only recalculate if block number changed
        if (
            currentBlockNumber !== this.lastBlockNumber ||
            this.cachedValidators.length === 0
        ) {
            log.debug(
                `[DTR RetryService] Block number changed (${this.lastBlockNumber} -> ${currentBlockNumber}), recalculating validators`,
            )

            try {
                const { commonValidatorSeed } = await getCommonValidatorSeed()
                const validators = await getShard(commonValidatorSeed)

                // Filter and cache validators
                this.cachedValidators = validators.filter(
                    v => v.status.online && v.sync.status,
                )
                this.lastBlockNumber = currentBlockNumber

                log.debug(
                    `[DTR RetryService] Cached ${this.cachedValidators.length} validators for block ${currentBlockNumber}`,
                )
            } catch (error) {
                log.error(
                    "[DTR RetryService] Error recalculating validators: " +
                        error,
                )
                return []
            }
        }

        // Return validators in random order for load balancing
        return [...this.cachedValidators].sort(() => Math.random() - 0.5)
    }

    /**
     * Attempts to relay a transaction to a validator
     *
     * @param validator - Validator to relay to
     * @param validityData - ValidityData of the transaction to relay
     *
     * @returns RPCResponse
     */
    public static async relayTransactions(
        validator: Peer,
        payload: ValidityData[],
    ): Promise<RPCResponse> {
        try {
            log.debug(
                "[DTR] Attempting to relay transaction to validator: " +
                    validator.identity,
            )
            log.debug("[DTR] ValidityData: " + JSON.stringify(payload))

            const request: RPCRequest = {
                method: "nodeCall",
                params: [
                    {
                        message: "RELAY_TX",
                        data: {
                            payload,
                            blockNumber: getSharedState.lastBlockNumber,
                        },
                    },
                ],
            }
            const res = await validator.longCall(request, true, {
                sleepTime: 250,
                retries: 4,
                allowedCodes: [400, 403], // Allowed error response codes
            })

            return {
                ...res,
                extra: {
                    ...(res.extra ? res.extra : {}),
                    peer: validator.identity,
                },
            }
        } catch (error) {
            log.error("[DTR] Error relaying transaction to validator: " + error)
            return {
                result: 500,
                response: {
                    error: error,
                },
                require_reply: false,
                extra: {
                    peer: validator.identity,
                },
            }
        }
    }

    /**
     * Attempts to relay a single transaction to all available validators
     *
     * @param transaction - Transaction to relay
     * @param validators - Array of available validators
     */
    private async tryRelayTransaction(
        transaction: any,
        validators: any[],
    ): Promise<void> {
        const txHash = transaction.hash
        const currentAttempts = this.retryAttempts.get(txHash) || 0

        // Give up after max attempts
        if (currentAttempts >= this.maxRetryAttempts) {
            log.warning(
                `[DTR RetryService] Giving up on transaction ${txHash} after ${this.maxRetryAttempts} attempts`,
            )
            this.retryAttempts.delete(txHash)
            // Clean up ValidityData from memory
            getSharedState.validityDataCache.delete(txHash)
            return
        }

        // Check if we have ValidityData in memory
        const validityData = getSharedState.validityDataCache.get(txHash)
        if (!validityData) {
            log.error(
                `[DTR RetryService] No ValidityData found for ${txHash}, removing from mempool`,
            )
            await Mempool.removeTransaction(txHash)
            this.retryAttempts.delete(txHash)
            return
        }

        // Try all validators in random order
        for (const validator of validators) {
            try {
                const result = await validator.call(
                    {
                        method: "nodeCall",
                        params: [
                            {
                                type: "RELAY_TX",
                                data: {
                                    transaction,
                                    validityData: validityData,
                                },
                            },
                        ],
                    },
                    true,
                )

                if (result.result === 200) {
                    log.info(
                        `[DTR RetryService] Successfully relayed ${txHash} to ${validator.identity.substring(0, 8)}... (attempt ${currentAttempts + 1})`,
                    )

                    // Remove from local mempool since it's now in validator's mempool
                    await Mempool.removeTransaction(txHash)
                    this.retryAttempts.delete(txHash)
                    getSharedState.validityDataCache.delete(txHash)
                    return // Success!
                }

                log.debug(
                    `[DTR RetryService] Validator ${validator.identity.substring(0, 8)}... rejected ${txHash}: ${result.response}`,
                )
            } catch (error) {
                const errorMsg =
                    error instanceof Error ? error.message : String(error)
                log.debug(
                    `[DTR RetryService] Validator ${validator.identity.substring(0, 8)}... error for ${txHash}: ${errorMsg}`,
                )
                continue // Try next validator
            }
        }

        // All validators failed, increment attempt count
        this.retryAttempts.set(txHash, currentAttempts + 1)
        log.warn(
            `[DTR RetryService] Attempt ${currentAttempts + 1}/${this.maxRetryAttempts} failed for ${txHash}`,
        )
    }

    static async receiveRelayedTransactions(data: {
        payload: ValidityData[]
        blockNumber: number
    }): Promise<RPCResponse> {
        const response = await Promise.all(
            data.payload.map(payload =>
                this.receiveRelayedTransaction(payload, data.blockNumber),
            ),
        )

        return {
            result: 200,
            response,
            extra: null,
            require_reply: false,
        }
    }

    /**
     * Adds the transaction to the validity data cache and starts the relay waiter
     *
     * @param validityData - ValidityData of the transaction to receive
     *
     * @returns RPCResponse
     */
    static async inConsensusHandler(validityData: ValidityData) {
        log.debug(
            "[inConsensusHandler] in consensus loop, adding tx in cache: " +
                validityData.data.transaction.hash,
        )
        DTRManager.validityDataCache.set(
            validityData.data.transaction.hash,
            validityData,
        )

        // INFO: Start the relay waiter
        if (!DTRManager.isWaitingForBlock) {
            log.debug(
                "[inConsensusHandler] not waiting for block, starting relay",
            )
            DTRManager.waitForBlockThenRelay()
        }

        log.debug("[inConsensusHandler] returning success")
        return {
            success: true,
            response: {
                message: "Transaction relayed to validators",
            },
            extra: {
                confirmationBlock: getSharedState.lastBlockNumber + 1,
            },
            require_reply: false,
        }
    }

    /**
     * Receives a relayed transaction from a validator
     *
     * @param validityData - ValidityData of the transaction to receive
     *
     * @returns RPCResponse
     */
    static async receiveRelayedTransaction(
        validityData: ValidityData,
        blockNumber: number,
    ) {
        const response: RPCResponse = {
            result: 200,
            response: null,
            extra: {
                txhash: validityData.data.transaction.hash,
            },
            require_reply: false,
        }

        try {
            if (getSharedState.inConsensusLoop) {
                return await this.inConsensusHandler(validityData)
            }

            // 1. Verify we are actually a validator for next block
            const isValidator = await isValidatorForNextBlock()
            if (!isValidator) {
                log.error("[DTR] Rejecting relay: not a validator")

                return {
                    ...response,
                    result: 403,
                    response: {
                        message: "Node is not a validator for next block",
                    },
                }
            }

            // 2. Make sure we're using the same signing algorithm
            const isSameSigningAlgorithm =
                validityData.rpc_public_key.type ===
                getSharedState.signingAlgorithm
            log.debug(
                "[DTR] Relayed tx isSameSigningAlgorithm: " +
                    isSameSigningAlgorithm,
            )
            if (!isSameSigningAlgorithm) {
                log.error(
                    "[DTR] Transaction relayed with different signing algorithm",
                )
                return {
                    ...response,
                    result: 401,
                    response: {
                        message:
                            "REJECTED: Transaction relayed with different signing algorithm",
                    },
                }
            }

            // 2. Verify receipt from a known validator
            const isFromKnownValidator = (
                await PeerManager.getInstance().getOnlinePeers()
            ).some(
                // Assuming both nodes are running on same signing algorithm
                peer => peer.identity === validityData.rpc_public_key.data,
            )
            log.debug(
                "[DTR] Relayed tx isFromKnownValidator: " +
                    isFromKnownValidator,
            )
            log.debug(
                "[DTR] Relayed tx validator identity: " +
                    validityData.rpc_public_key.data,
            )

            if (!isFromKnownValidator) {
                log.error("[DTR] Transaction relayed from unknown validator")

                return {
                    ...response,
                    result: 401,
                    response: {
                        message:
                            "REJECTED: Transaction relayed from unknown validator",
                    },
                }
            }

            // 3. Verify validity data against sender signature
            const isSignatureValid = await TxValidatorPool.getInstance().verify(
                {
                    algorithm: validityData.rpc_public_key
                        .type as SigningAlgorithm,
                    message: new TextEncoder().encode(
                        Hashing.sha256(JSON.stringify(validityData.data)),
                    ),
                    publicKey: hexToUint8Array(
                        validityData.rpc_public_key.data,
                    ),
                    signature: hexToUint8Array(validityData.signature.data),
                },
            )

            log.debug("[DTR] Relayed tx isSignatureValid: " + isSignatureValid)
            log.debug(
                "[DTR] Relayed tx signature: " + validityData.signature.data,
            )
            log.debug(
                "[DTR] Relayed tx public key: " +
                    validityData.rpc_public_key.data,
            )

            if (!isSignatureValid) {
                log.error("[DTR] Validity data signature validation failed")

                return {
                    ...response,
                    result: 400,
                    response: {
                        message:
                            "REJECTED: Validity data signature validation failed",
                    },
                }
            }

            const tx = validityData.data.transaction

            // 4. Validate transaction coherence (hash matches content)
            const isCoherent = TxUtils.isCoherent(tx)

            log.debug("[DTR] Relayed tx isCoherent: " + isCoherent)
            if (!isCoherent) {
                log.error(
                    "[DTR] Transaction coherence validation failed: " + tx.hash,
                )

                return {
                    ...response,
                    result: 400,
                    response: "REJECTED: Transaction hash mismatch",
                }
            }

            // Validate transaction signature
            const { success } = await TxUtils.validateSignature(tx)
            log.debug(
                "[DTR] Relayed tx signature validation success: " + success,
            )

            if (!success) {
                log.error(
                    "[DTR] Transaction signature validation failed: " + tx.hash,
                )

                return {
                    ...response,
                    result: 400,
                    response: {
                        message:
                            "REJECTED: Transaction signature validation failed",
                    },
                }
            }

            // Add validated transaction to mempool
            const { confirmationBlock, error } = await Mempool.addTransaction(
                {
                    ...tx,
                    reference_block: validityData.data.reference_block,
                },
                blockNumber,
            )

            log.debug(
                "[DTR] Relayed tx confirmationBlock: " + confirmationBlock,
            )
            log.debug("[DTR] Relayed tx error: " + error)

            if (error) {
                log.error(
                    "[DTR] Failed to add relayed transaction to mempool: " +
                        error,
                )

                return {
                    ...response,
                    result: 500,
                    response: {
                        message: "Failed to add relayed transaction to mempool",
                    },
                }
            }

            log.debug(
                "[DTR] Successfully added relayed transaction to mempool: " +
                    tx.hash,
            )
            return {
                ...response,
                result: 200,
                response: {
                    message: "Relayed transaction accepted",
                    confirmationBlock,
                },
            }
        } catch (error) {
            log.error("[DTR] Error processing relayed transaction: " + error)

            return {
                ...response,
                result: 500,
                response: {
                    message: "FAILED: Error processing relayed transaction",
                },
            }
        }
    }

    static async waitForBlockThenRelay() {
        let cvsa: string

        // eslint-disable-next-line no-constant-condition
        while (true) {
            try {
                cvsa = await Waiter.wait(
                    Waiter.keys.DTR_WAIT_FOR_BLOCK,
                    120_000,
                )
                log.debug("waitForBlockThenRelay resolved. CVSA: " + cvsa)
                break
            } catch (error) {
                if (!getSharedState.inConsensusLoop) {
                    const { commonValidatorSeed } =
                        await getCommonValidatorSeed()
                    cvsa = commonValidatorSeed
                    break
                }

                log.error(
                    "[waitForBlockThenRelay] Error waiting for block, retrying...",
                )
            }
        }

        const validators = await getShard(cvsa)
        const txs = Array.from(DTRManager.validityDataCache.values())

        //INFO: Filter transactions applied in last block
        const lastBlockTxs = await Chain.getLastBlockTransactionSet()
        const txsToRelay = txs.filter(
            tx => !lastBlockTxs.has(tx.data.transaction.hash),
        )

        // if we're up next, keep the transactions
        if (validators.some(v => v.identity === getSharedState.publicKeyHex)) {
            log.debug(
                "[waitForBlockThenRelay] We're up next, keeping transactions",
            )
            return await Promise.all(
                txsToRelay.map(tx => {
                    Mempool.addTransaction(
                        {
                            ...tx.data.transaction,
                            reference_block: tx.data.reference_block,
                        },
                        getSharedState.lastBlockNumber + 1,
                    )

                    // INFO: Remove tx from cache
                    DTRManager.validityDataCache.delete(
                        tx.data.transaction.hash,
                    )
                }),
            )
        }

        log.debug("[waitForBlockThenRelay] Relaying transactions to validators")
        const nodeResults = await Promise.all(
            validators.map(validator =>
                this.relayTransactions(validator, txsToRelay),
            ),
        )

        for (const result of nodeResults) {
            log.debug(
                "[waitForBlockThenRelay] relay result: " +
                    JSON.stringify(result),
            )

            if (result.result === 200) {
                for (const txres of result.response) {
                    if (txres.result === 200) {
                        log.debug("deleting tx: " + txres.extra.txhash)
                        DTRManager.validityDataCache.delete(txres.extra.txhash)
                    }
                }
            }
        }
    }
}
