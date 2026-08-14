import Mempool from "../../blockchain/mempool"
import { getEligiblePool } from "../../consensus/v2/routines/getShard"
import { getSharedState } from "../../../utilities/sharedState"
import log from "../../../utilities/logger"
import { Peer, PeerManager } from "@/libs/peer"
import {
    RPCRequest,
    RPCResponse,
    SigningAlgorithm,
    ValidityData,
} from "@kynesyslabs/demosdk/types"
import { Hashing, hexToUint8Array } from "@kynesyslabs/demosdk/encryption"

import TxUtils from "../../blockchain/transaction"
import Chain from "@/libs/blockchain/chain"
import TxValidatorPool from "@/libs/blockchain/validation/txValidatorPool"
import { handleError } from "@/errors"
import { deepWindowCutoff } from "@/libs/blockchain/referenceBlockWindow"

const MAX_CACHED_RELAY_TXS = 5_000

/**
 * DTR (Distributed Transaction Routing)
 *
 * Incoming transactions are broadcast immediately to enough eligible-pool
 * validators that every possible next shard contains at least one holder
 * (pool - shardSize + 1 successful deliveries; see broadcastToPool).
 *
 * A receiver that is mid-consensus stages the transaction and flushes it
 * into its mempool once the round ends (flushStagedToMempool); otherwise
 * it inserts directly.
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

    static get parkedConfirmationBlock(): number {
        return getSharedState.lastBlockNumber + 2
    }

    static stage(validityData: ValidityData) {
        const txhash = validityData.data.transaction.hash

        if (
            !DTRManager.validityDataCache.has(txhash) &&
            DTRManager.validityDataCache.size >= MAX_CACHED_RELAY_TXS
        ) {
            const oldest = DTRManager.validityDataCache.keys().next()
            if (!oldest.done) {
                log.warning(
                    `[DTR] Staging area full (${MAX_CACHED_RELAY_TXS}), dropping ${oldest.value}`,
                )
                DTRManager.validityDataCache.delete(oldest.value)
            }
        }

        DTRManager.validityDataCache.set(txhash, validityData)
    }

    static readConfirmationBlock(res: RPCResponse): number | null {
        const fromResponse = (res.response as { confirmationBlock?: number })
            ?.confirmationBlock
        const fromExtra = (res.extra as { confirmationBlock?: number })
            ?.confirmationBlock
        const value = fromResponse ?? fromExtra

        return typeof value === "number" ? value : null
    }

    /**
     * Confirmation block to advertise for a broadcast: the most common
     * value among the accepted responses. The majority of the pool shares
     * the true network view, so the mode discards both stale laggards and
     * single ahead-of-tip outliers. Ties break to the later block — the
     * benign error direction (a transaction confirms earlier than promised,
     * never later). Confirmations at or below our own tip come from lagging
     * peers and are ignored.
     */
    static aggregateConfirmationBlock(results: RPCResponse[]): number | null {
        const floor = getSharedState.lastBlockNumber + 1
        const candidates = results
            .filter(res => res.result === 200)
            .map(res => DTRManager.readConfirmationBlock(res))
            .filter((block): block is number => block !== null && block >= floor)

        if (candidates.length === 0) {
            return null
        }

        const counts = new Map<number, number>()
        for (const block of candidates) {
            counts.set(block, (counts.get(block) ?? 0) + 1)
        }

        let best: number | null = null
        let bestCount = 0
        for (const [block, count] of counts) {
            if (
                count > bestCount ||
                (count === bestCount && best !== null && block > best)
            ) {
                best = block
                bestCount = count
            }
        }

        return best
    }

    /**
     * Broadcasts the payload to eligible-pool validators that any
     * shard drawn from the pool must contain at least one recipient:
     * pool - shardSize + 1 successful deliveries. Failed deliveries are
     * topped up from the remaining pool until the target is met or the
     * pool is exhausted.
     */
    static async broadcastToPool(
        payload: ValidityData[],
    ): Promise<RPCResponse[]> {
        const pool = await getEligiblePool(getSharedState.lastBlockNumber)
        const ourId = getSharedState.publicKeyHex
        const peerman = PeerManager.getInstance()

        const candidates = pool
            .filter(identity => identity !== ourId)
            .map(identity => peerman.getPeer(identity))
            .filter(peer => peer && peer.connection.string)
            .sort(() => Math.random() - 0.5)

        const coverageTarget = Math.max(
            1,
            pool.length - getSharedState.shardSize + 1,
        )
        const target = Math.min(candidates.length, coverageTarget)

        const results: RPCResponse[] = []
        let successes = 0
        let cursor = 0

        while (successes < target && cursor < candidates.length) {
            const batch = candidates.slice(
                cursor,
                cursor + (target - successes),
            )
            cursor += batch.length

            const responses = await Promise.all(
                batch.map(validator =>
                    DTRManager.relayTransaction(
                        validator,
                        payload,
                        getSharedState.lastBlockHash,
                    ),
                ),
            )

            for (const res of responses) {
                if (res.result === 200) {
                    successes++
                }
                results.push(res)
            }
        }

        if (successes < coverageTarget) {
            log.warning(
                `[DTR] Broadcast reached ${successes}/${coverageTarget} validators ` +
                    `(pool ${pool.length}, reachable ${candidates.length}): ` +
                    "next-shard coverage is not guaranteed",
            )
        }

        return results
    }

    static async relayTransaction(
        validator: Peer,
        payload: ValidityData[],
        blockRef: string,
    ): Promise<RPCResponse> {
        try {
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
                allowedCodes: [400, 403, 409], // Allowed error response codes
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

    static async receiveRelayedTransactions(
        data: {
            payload: ValidityData[]
            blockNumber: number
            blockRef: string
        },
        opts: { bypassStaging?: boolean } = {},
    ): Promise<RPCResponse> {
        log.debug(
            "[receiveRelayedTransactions] Receiving relayed transactions: " +
                data.payload.length,
        )
        log.debug(
            "[receiveRelayedTransactions] Receiving relayed transactions: " +
                JSON.stringify(
                    data.payload.map(vd => vd.data.transaction.hash),
                    null,
                    2,
                ),
        )

        try {
            if (!opts.bypassStaging && getSharedState.inConsensusLoop) {
                return await this.inConsensusHandler(data.payload)
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
            peerSet.add(getSharedState.publicKeyHex)

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

            const rpcSignatureValid = await Promise.all(
                payload.map(entry => verifyRPCSignature(entry)),
            )
            payload = payload.filter((_, index) => rpcSignatureValid[index])

            const targetBlock = getSharedState.lastBlockNumber + 1
            const txs = payload.map(vd => ({
                ...vd.data.transaction,
                timestamp: BigInt(vd.data.transaction.content.timestamp),
                nonce: vd.data.transaction.content.nonce,
                blockNumber: targetBlock,
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
                    confirmationBlock: targetBlock,
                },
                require_reply: false,
                extra: {
                    confirmationBlock: targetBlock,
                    lastBlockNumber: getSharedState.lastBlockNumber,
                },
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
     * Stages the transactions until the running consensus round ends
     *
     * @param payload - ValidityData of the transaction to receive
     *
     * @returns RPCResponse
     */
    static async inConsensusHandler(payload: ValidityData[]) {
        const confirmationBlock = DTRManager.parkedConfirmationBlock

        for (const validityData of payload) {
            DTRManager.stage(validityData)
        }

        return {
            success: true,
            result: 200,
            response: {
                message:
                    "Transaction received during consensus, confirmation in next block",
                confirmationBlock,
            },
            extra: {
                confirmationBlock,
                lastBlockNumber: getSharedState.lastBlockNumber,
                staged: true,
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

        log.debug(
            "[receiveRelayedTransaction] Receiving relayed transaction: " +
                validityData.data.transaction.hash,
        )

        try {
            // Make sure we're using the same signing algorithm
            const isSameSigningAlgorithm =
                validityData.rpc_public_key.type ===
                getSharedState.signingAlgorithm

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
            const isFromKnownValidator =
                validityData.rpc_public_key.data ===
                    getSharedState.publicKeyHex ||
                (await PeerManager.getInstance().getOnlinePeers()).some(
                    // Assuming both nodes are running on same signing algorithm
                    peer => peer.identity === validityData.rpc_public_key.data,
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

            // Validate transaction signature
            const { success } = await TxUtils.validateSignature(tx)

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
            const { confirmationBlock, error } = await Mempool.addTransaction({
                ...tx,
                reference_block: validityData.data.reference_block,
            })

            log.debug(
                "[receiveRelayedTransaction] Added relayed transaction to mempool: " +
                    tx.hash,
            )
            log.debug("Block Number: " + blockNumber)
            log.debug("Confirmation Block: " + confirmationBlock)
            log.debug(
                "Tx reference block: " + validityData.data.reference_block,
            )

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

            return {
                ...response,
                result: 200,
                response: {
                    message: "Relayed transaction accepted",
                    confirmationBlock,
                },
                extra: {
                    ...response.extra,
                    confirmationBlock,
                    lastBlockNumber: getSharedState.lastBlockNumber,
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

    /**
     * Flushes staged transactions into the local mempool.
     *
     * Unforced calls are a no-op while a consensus round is running. The
     * round-end path in consensusRoutine calls this with `force` BEFORE the
     * consensus flags are cleared: no new round can start while
     * inConsensusLoop is still set, so the flush cannot race the next
     * round's mempool snapshot — which is what strands staged transactions
     * for an extra block during back-to-back catch-up rounds.
     */
    static async flushStagedToMempool(force = false): Promise<void> {
        if (DTRManager.validityDataCache.size === 0) {
            return
        }
        if (!force && getSharedState.inConsensusLoop) {
            return
        }

        try {
            const staged = Array.from(DTRManager.validityDataCache.values())

            const lastBlockTxs = await Chain.getLastBlockTransactionSet()
            const staleCutoff = deepWindowCutoff(
                getSharedState.lastBlockNumber,
            )
            const toFlush: ValidityData[] = []

            for (const tx of staged) {
                const txhash = tx.data.transaction.hash

                if (lastBlockTxs.has(txhash)) {
                    DTRManager.validityDataCache.delete(txhash)
                    continue
                }

                if (tx.data.reference_block < staleCutoff) {
                    log.warning(
                        `[DTR] Dropping ${txhash}: reference block ` +
                            `${tx.data.reference_block} is below the deep window cutoff ${staleCutoff}`,
                    )
                    DTRManager.validityDataCache.delete(txhash)
                    continue
                }

                toFlush.push(tx)
            }

            if (toFlush.length === 0) {
                return
            }

            const flushed = await Mempool.lock.runExclusive(async () => {
                if (!force && getSharedState.inConsensusLoop) {
                    return false
                }

                await DTRManager.receiveRelayedTransactions(
                    {
                        payload: toFlush,
                        blockRef: getSharedState.lastBlockHash,
                        blockNumber: getSharedState.lastBlockNumber + 1,
                    },
                    { bypassStaging: true },
                )
                return true
            })

            if (flushed) {
                for (const tx of toFlush) {
                    DTRManager.validityDataCache.delete(
                        tx.data.transaction.hash,
                    )
                }
            }
        } catch (error) {
            log.error(
                "[DTR] Error flushing staged transactions to mempool: " +
                    (error instanceof Error ? error.message : String(error)),
            )
        }
    }
}
