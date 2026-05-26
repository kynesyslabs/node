import Mempool from "../../blockchain/mempool"
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
import { handleError } from "@/errors"

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

    // map of txhash to ValidityData
    public static validityDataCache = new Map<string, ValidityData>()

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

    static async relayTransaction(
        validator: Peer,
        payload: ValidityData[],
        blockRef: string,
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
                            // INFO: hash of block used to get cvsa used to select this validator
                            blockRef: blockRef,
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
                    txhashes: payload.map(vd => vd.data.transaction.hash),
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
     * Attempts to relay a transaction to a validator
     *
     * @param validator - Validator to relay to
     * @param validityData - ValidityData of the transaction to relay
     *
     * @returns RPCResponse
     */
    public static async relayTransactions(
        validators: Peer[],
        payload: ValidityData[],
        lastBlockHash: string,
    ): Promise<RPCResponse> {
        const availableValidators = validators.sort(() => Math.random() - 0.5)

        const results = await Promise.all(
            availableValidators.map(validator =>
                this.relayTransaction(validator, payload, lastBlockHash),
            ),
        )

        return {
            result: 200,
            response: results,
            extra: null,
            require_reply: false,
        }
    }

    static async receiveRelayedTransactions(data: {
        payload: ValidityData[]
        blockNumber: number
        blockRef: string
    }): Promise<RPCResponse> {
        try {
            if (getSharedState.inConsensusLoop) {
                if (
                    !(
                        getSharedState.candidateBlock &&
                        getSharedState.candidateBlock.hash === data.blockRef
                    )
                ) {
                    return await this.inConsensusHandler(data.payload)
                }
            }

            if (data.payload.length === 1) {
                return await this.receiveRelayedTransaction(
                    data.payload[0],
                    data.blockNumber,
                )
            }

            // INFO: Filter by signing algorithm
            const peers = await PeerManager.getInstance().getOnlinePeers()
            const peerSet = new Set(peers.map(peer => peer.identity))

            let payload = data.payload.filter(
                payload =>
                    payload.rpc_public_key.type ===
                        getSharedState.signingAlgorithm &&
                    peerSet.has(payload.rpc_public_key.data),
            )

            const verifyRPCSignature = async (payload: ValidityData) => {
                return await TxValidatorPool.getInstance().verify({
                    algorithm: payload.rpc_public_key.type as SigningAlgorithm,
                    message: new TextEncoder().encode(
                        Hashing.sha256(JSON.stringify(payload.data)),
                    ),
                    publicKey: hexToUint8Array(payload.rpc_public_key.data),
                    signature: hexToUint8Array(payload.signature.data),
                })
            }

            payload = payload.filter(async payload => {
                return await verifyRPCSignature(payload)
            })

            const txs = payload.map(vd => ({
                ...vd.data.transaction,
                timestamp: BigInt(vd.data.transaction.content.timestamp),
                nonce: vd.data.transaction.content.nonce,
                blockNumber: data.blockNumber,
                reference_block: vd.data.reference_block,
            }))

            const { success } = await Mempool.receive(txs, false)

            if (!success) {
                return {
                    result: 400,
                    response: {
                        message: "Failed to receive relayed transactions",
                    },
                    require_reply: false,
                    extra: null,
                }
            }

            return {
                result: 200,
                response: {
                    message: "Relayed transactions received",
                },
                require_reply: false,
                extra: null,
            }
        } catch (error) {
            handleError(error)

            return {
                result: 500,
                response: {
                    message: "Failed to receive relayed transactions",
                },
                require_reply: false,
                extra: null,
            }
        }
    }

    /**
     * Adds the transaction to the validity data cache and starts the relay waiter
     *
     * @param payload - ValidityData of the transaction to receive
     *
     * @returns RPCResponse
     */
    static async inConsensusHandler(payload: ValidityData[]) {
        for (const validityData of payload) {
            DTRManager.validityDataCache.set(
                validityData.data.transaction.hash,
                validityData,
            )
        }

        // INFO: Start the relay waiter
        if (!DTRManager.isWaitingForBlock) {
            log.debug(
                "[inConsensusHandler] not waiting for block, starting relay",
            )
            DTRManager.waitForBlockThenRelay()
        }

        return {
            success: true,
            result: 200,
            response: {
                message:
                    "Transaction received during consensus, confirmation in next block",
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
            // Make sure we're using the same signing algorithm
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

            // Note: staking/governance type dispatcher runs in
            // confirmTransaction() before validityData is signed, so by
            // the time we reach this point on the relay receiver, the tx
            // already carries any synthesized gcr_edit and signature
            // verification above attests to it. No additional dispatcher
            // call is needed here.

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
            const res = await this.receiveRelayedTransactions({
                payload: txsToRelay,
                blockRef: getSharedState.lastBlockHash,
                blockNumber: getSharedState.lastBlockNumber + 1,
            })

            for (const tx of txsToRelay) {
                DTRManager.validityDataCache.delete(tx.data.transaction.hash)
            }

            return res
        }

        log.debug("[waitForBlockThenRelay] Relaying transactions to validators")

        const nodeResults = await this.relayTransactions(
            validators,
            txsToRelay,
            getSharedState.lastBlockHash,
        )

        for (const result of nodeResults.response as RPCResponse[]) {
            if (result.result === 200) {
                for (const txhash of result.extra?.txhashes ?? []) {
                    DTRManager.validityDataCache.delete(txhash)
                }
            }
        }
    }
}
