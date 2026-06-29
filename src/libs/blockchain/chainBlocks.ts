import { LessThan, MoreThan } from "typeorm"
import log from "src/utilities/logger"
import Block from "./block"
import Mempool from "./mempool"
import Transaction, { toTransactionsEntity } from "./transaction"
import Datasource from "src/model/datasource"
import { Blocks } from "src/model/entities/Blocks"
import { Transactions } from "src/model/entities/Transactions"
import { IdentityCommitment } from "src/model/entities/GCRv2/IdentityCommitment"
import { getSharedState } from "src/utilities/sharedState"
import { updateMerkleTreeAfterBlock } from "@/features/zk/merkle/updateMerkleTreeAfterBlock"
import { CHUNK_TRANSACTIONS, chunkedInsert, getBlocksRepo } from "./chainDb"
import { persistConfirmedTransactionProjection } from "./chainTransactions"
import tallyUpgradeVotes from "./routines/tallyUpgradeVotes"
import applyNetworkUpgrade from "./routines/applyNetworkUpgrade"
import { loadNetworkParameters } from "./routines/loadNetworkParameters"
import { NetworkUpgrade } from "@/model/entities/NetworkUpgrade"
import { NetworkUpgradeVote } from "@/model/entities/NetworkUpgradeVote"
import {
    isOsDenominationMigrationApplied,
    runOsDenominationMigration,
} from "@/forks/migrations/osDenomination"
import {
    isGasFeeSeparationMigrationApplied,
    runGasFeeSeparationMigration,
} from "@/forks/migrations/gasFeeSeparation"
import { isForkActive } from "@/forks/forkGates"
import { isForkMachineryDisabled } from "@/forks/loadForkConfig"
import type { FindManyOptions } from "typeorm"
import { TRANSACTION_STATUS } from "@/utilities/constants"

export function isGenesis(block: Block): boolean {
    if (block.number === 0) {
        return true
    }
    return false
}

export async function getLastBlock(): Promise<Blocks> {
    const blocks = getBlocksRepo()
    if (!getSharedState.lastBlockNumber) {
        return await blocks
            .createQueryBuilder("block")
            .orderBy("block.number", "DESC")
            .limit(1)
            .getOne()
    }

    return await getBlockByNumber(getSharedState.lastBlockNumber)
}

export async function getLastBlockNumber(): Promise<number> {
    if (!getSharedState.lastBlockNumber) {
        const block = await getBlocksRepo()
            .createQueryBuilder("block")
            .select("block.number")
            .orderBy("block.number", "DESC")
            .limit(1)
            .getOne()

        return block ? block.number : 0
    }

    return getSharedState.lastBlockNumber
}

export async function getLastBlockHash() {
    if (!getSharedState.lastBlockHash) {
        const block = await getBlocksRepo()
            .createQueryBuilder("block")
            .select("block.hash")
            .orderBy("block.number", "DESC")
            .limit(1)
            .getOne()

        return block ? block.hash : null
    }

    return getSharedState.lastBlockHash
}

export async function getLastBlockTransactionSet(): Promise<Set<string>> {
    const query = getBlocksRepo()
        .createQueryBuilder("block")
        .select("block.content")

    if (getSharedState.lastBlockNumber) {
        query.where("block.number = :number", {
            number: getSharedState.lastBlockNumber,
        })
    } else {
        query.orderBy("block.number", "DESC").limit(1)
    }

    const block = await query.getOne()
    return new Set(block?.content?.ordered_transactions ?? [])
}

export async function getLastBlockSigners(): Promise<string[]> {
    const lastBlock = await getBlocksRepo().findOne({
        where: { number: getSharedState.lastBlockNumber },
        select: ["validation_data"],
    })

    const sigs = lastBlock?.validation_data?.signatures
    return sigs ? Object.keys(sigs) : []
}

export async function getBlocks(
    start: "latest" | number,
    limit: number,
): Promise<Blocks[]> {
    const blocks = getBlocksRepo()
    const calculatedLimit = Math.min(limit, getSharedState.batchSyncBlockLimit)

    let options: FindManyOptions<Blocks> = {
        order: { number: "DESC" },
        take: calculatedLimit,
    }

    if (start !== "latest") {
        options = { ...options, where: { number: LessThan(start + 1) } }
    }

    return await blocks.find(options)
}

export async function getBlockByNumber(number: number): Promise<Blocks> {
    return await getBlocksRepo().findOneBy({ number })
}

export async function getBlockByHash(hash: string): Promise<Blocks> {
    return await getBlocksRepo().findOneBy({ hash: hash })
}

export async function getGenesisBlock(): Promise<Blocks> {
    return await getBlockByNumber(0)
}

export async function getGenesisBlockHash(): Promise<string> {
    const genesisBlock = await getBlocksRepo().findOne({
        where: { number: 0 },
        select: { hash: true },
    })
    return genesisBlock ? genesisBlock.hash : null
}

export async function getOnlinePeersForLastThreeBlocks(): Promise<any[]> {
    const lastBlockNumber = await getLastBlockNumber()

    if (lastBlockNumber < 3) {
        return []
    }

    const blocks = await getBlocks("latest", 3)

    try {
        const { getTransactionsFromHashes } =
            await import("./chainTransactions")

        const processedBlocks = await Promise.all(
            blocks.map(async block => {
                const transactions = await getTransactionsFromHashes(
                    block.content.ordered_transactions,
                )

                const onlinePeersInBlockTransactions = transactions
                    .filter(
                        transaction =>
                            transaction?.content.type === "NODE_ONLINE",
                    )
                    .map(transaction => (transaction?.content as any).data)

                const onlinePeersInBlock = onlinePeersInBlockTransactions.map(
                    onlineTxRaw => {
                        const onlineTx = JSON.parse(onlineTxRaw[0])
                        return onlineTx.data
                    },
                )

                return onlinePeersInBlock
            }),
        )

        const commonPeers = processedBlocks.reduce((common, peersInBlock) => {
            return common.filter(peer => peersInBlock.includes(peer))
        }, processedBlocks[0] || [])

        return commonPeers
    } catch (e) {
        return []
    }
}

export async function insertBlock(
    block: Block,
    blockTxs: Transaction[],
    position?: number,
): Promise<Blocks> {
    const blocksRepo = getBlocksRepo()
    const orderedTransactionsHashes = block.content.ordered_transactions

    const newBlock = new Blocks()
    newBlock.hash = block.hash
    newBlock.number = block.number
    newBlock.proposer = block.proposer
    newBlock.next_proposer = block.next_proposer
    newBlock.status = block.status
    newBlock.validation_data = block.validation_data
    newBlock.content = block.content
    newBlock.status = "confirmed"
    newBlock.content.ordered_transactions = orderedTransactionsHashes
    newBlock.attrs = block.attrs

    let existingBlock = null

    existingBlock = await blocksRepo.findOneBy({
        hash: block.hash,
    })

    if (existingBlock && position) {
        log.info(
            "[ChainDB] [ INFO ]: Block with position " +
                position +
                " does exist: updating a new block",
        )
        existingBlock.content = block.content
        existingBlock.number = block.number
        existingBlock.hash = block.hash
        existingBlock.status = block.status
        existingBlock.proposer = block.proposer
        existingBlock.validation_data = block.validation_data
        log.info("about to save block")
        return await blocksRepo.save(existingBlock)
    }

    if (existingBlock && !position) {
        log.info(
            "[ChainDB] [ INFO ]: Block with hash " +
                block.hash +
                " already exists: returning existing block",
        )
        return existingBlock
    }

    let transactionEntities: Transaction[] = []

    if (blockTxs.length > 0 && block.content.ordered_transactions.length > 0) {
        // NODE_CRITICAL_DEBUG (DO NOT REMOVE COMMENTED OUT CODE):
        // confirm array contains all the txs in the block
        const blockTxsHashes = blockTxs.map(tx => tx.hash)
        const blockOrderedTransactionsHashes =
            block.content.ordered_transactions

        if (
            blockTxsHashes.every(hash =>
                blockOrderedTransactionsHashes.includes(hash),
            )
        ) {
            transactionEntities = blockTxs
        }

        // NODE_CRITICAL_DEBUG (DO NOT REMOVE COMMENTED OUT CODE):
        else {
            log.error(
                "Block transactions mismatch with block ordered transactions",
            )
            process.exit(1)
        }

        const status = new Set([
            TRANSACTION_STATUS.CONFIRMED,
            TRANSACTION_STATUS.FAILED,
        ])

        // confirm all txs have a status set
        const txsWithoutStatus = transactionEntities.filter(
            tx => !status.has(tx.status),
        )
        if (txsWithoutStatus.length > 0) {
            log.error(
                "Transactions without status: " +
                    JSON.stringify(txsWithoutStatus, null, 2),
            )
            process.exit(1)
        }

        transactionEntities = transactionEntities.map(tx => ({
            ...tx,
            blockNumber: block.number,
        }))
    }

    log.debug("================================================")
    log.debug("Saving Transactions for block: " + block.number)
    log.debug(
        JSON.stringify(
            transactionEntities.map(tx => tx.hash),
            null,
            2,
        ),
    )
    log.debug("================================================")

    const db = await Datasource.getInstance()
    const dataSource = db.getDataSource()

    try {
        const result = await dataSource.transaction(
            async transactionalEntityManager => {
                const saveBlockStart = Date.now()
                // REVIEW: P3b — fork-activation hook. Runs *before* the
                // block is persisted so balances are migrated atomically
                // with the triggering block. Either both commit or both
                // roll back. Idempotency is enforced by `fork_state`.
                //
                // No-op when the fork is inactive (default in production:
                // activationHeight === null in DEFAULT_FORK_CONFIG) OR when
                // the rehearsal-only `DEMOS_DISABLE_FORK_MACHINERY` flag is
                // set (used to simulate a pre-fork binary without
                // maintaining a separate branch). Production must NEVER
                // set that flag.
                if (
                    !isForkMachineryDisabled() &&
                    isForkActive("osDenomination", block.number) &&
                    !(await isOsDenominationMigrationApplied(
                        transactionalEntityManager,
                    ))
                ) {
                    log.info(
                        `[forks][osDenomination] activation hook firing at block ${block.number}`,
                    )
                    await runOsDenominationMigration(
                        transactionalEntityManager,
                        block.number,
                    )
                }

                // DEM-665: gasFeeSeparation activation hook. MUST run
                // AFTER osDenomination at the same block height so that
                // when burn/treasury accounts are created with balance
                // 0n they are already in OS units (matching every other
                // post-fork account). Order is enforced here by listing
                // osDenomination's hook first.
                //
                // Same atomicity / idempotency story as osDenomination:
                // runs inside the caller transaction (rolls back with
                // the block on failure), fork_state row guards re-runs.
                if (
                    !isForkMachineryDisabled() &&
                    isForkActive("gasFeeSeparation", block.number) &&
                    !(await isGasFeeSeparationMigrationApplied(
                        transactionalEntityManager,
                    ))
                ) {
                    log.info(
                        `[forks][gasFeeSeparation] activation hook firing at block ${block.number}`,
                    )
                    await runGasFeeSeparationMigration(
                        transactionalEntityManager,
                        block.number,
                        getSharedState.forkConfig.gasFeeSeparation
                            .treasuryAddress,
                    )
                }

                const savedBlock = await transactionalEntityManager.save(
                    blocksRepo.target,
                    newBlock,
                )

                if (block.number > getSharedState.lastBlockNumber) {
                    getSharedState.lastBlockNumber = block.number
                    getSharedState.lastBlockHash = block.hash
                }

                const saveBlockEnd = Date.now()
                log.only(
                    `[insertBlock] Save block took ${saveBlockEnd - saveBlockStart}ms`,
                )

                const insertTransactionsStart = Date.now()

                if (transactionEntities.length > 0) {
                    const rawTransactions = transactionEntities.map(tx =>
                        Transaction.toRawTransaction(tx),
                    )

                    const { skipped } = await chunkedInsert(
                        transactionalEntityManager,
                        Transactions,
                        rawTransactions.map(tx => toTransactionsEntity(tx)),
                        CHUNK_TRANSACTIONS,
                    )
                    if (skipped > 0) {
                        log.warn(
                            `[ChainDB] Skipped ${skipped} duplicate transaction(s) in block ${block.number}`,
                        )
                    }

                    const l2psTxs = transactionEntities.filter(
                        tx => tx.content?.type === "l2ps_hash_update",
                    )
                    for (const tx of l2psTxs) {
                        await persistConfirmedTransactionProjection(
                            tx,
                            block.number,
                            transactionalEntityManager,
                        )
                    }
                }

                const insertTransactionsEnd = Date.now()
                log.only(
                    `[insertBlock] Insert ${transactionEntities.length} transactions took ${insertTransactionsEnd - insertTransactionsStart}ms`,
                )

                const commitmentsStart = Date.now()
                const committedTxHashes = transactionEntities.map(tx => tx.hash)
                if (committedTxHashes.length > 0) {
                    await transactionalEntityManager
                        .createQueryBuilder()
                        .update(IdentityCommitment)
                        .set({ blockNumber: block.number })
                        .where("transaction_hash IN (:...hashes)", {
                            hashes: committedTxHashes,
                        })
                        .andWhere("leaf_index = :leafIndex", {
                            leafIndex: -1,
                        })
                        .execute()
                }
                const commitmentsEnd = Date.now()
                log.only(
                    `[insertBlock] Commitments took ${commitmentsEnd - commitmentsStart}ms`,
                )

                const updateMerkleTreeStart = Date.now()
                const commitmentsAdded = await updateMerkleTreeAfterBlock(
                    dataSource,
                    block.number,
                    transactionalEntityManager,
                )
                if (commitmentsAdded > 0) {
                    log.info(
                        `[ZK] Added ${commitmentsAdded} commitment(s) to Merkle tree for block ${block.number}`,
                    )
                }
                const updateMerkleTreeEnd = Date.now()
                log.only(
                    `[insertBlock] Update Merkle tree took ${updateMerkleTreeEnd - updateMerkleTreeStart}ms`,
                )

                // Governance hooks scoped to the block transaction so they
                // commit/rollback atomically with it. sharedState refresh
                // is deferred to post-commit (below) — RAM never ahead of DB.
                const govProposalRepo =
                    transactionalEntityManager.getRepository(NetworkUpgrade)
                const govVoteRepo =
                    transactionalEntityManager.getRepository(NetworkUpgradeVote)
                await tallyUpgradeVotes(
                    block.number,
                    govProposalRepo,
                    govVoteRepo,
                )
                await applyNetworkUpgrade(block.number, govProposalRepo)

                return savedBlock
            },
        )

        // Post-commit refresh: rolled-back tx → no-op; committed tx →
        // picks up newly-active proposals. Failure is non-fatal — next
        // block will re-derive.
        try {
            await loadNetworkParameters()
        } catch (e) {
            log.warning(
                "GOVERNANCE",
                `[insertBlock] sharedState refresh after block ${block.number} failed: ${(e as Error).message}`,
            )
        }

        return result
    } catch (error) {
        log.error(
            `[ChainDB] [ ERROR ]: Failed to insert block ${block.number} with hash ${block.hash}: ${error}`,
        )
        throw error
    }
}

export async function pruneBlocksToGenesisBlock(): Promise<void> {
    await getBlocksRepo().delete({ number: MoreThan(0) })
    log.info("Pruned all blocks except the genesis block.")
}

export async function nukeGenesis(): Promise<void> {
    await getBlocksRepo().delete({ number: 0 })
    log.info("Deleted the genesis block.")
}

export async function updateGenesisTimestamp(
    newTimestamp: number,
): Promise<void> {
    const genesisBlock = await getBlocksRepo().findOneBy({ number: 0 })
    if (genesisBlock) {
        genesisBlock.content = {
            ...genesisBlock.content,
            timestamp: newTimestamp,
        }
        await getBlocksRepo().save(genesisBlock)
        log.info("Updated the timestamp of the genesis block.")
    }
}
