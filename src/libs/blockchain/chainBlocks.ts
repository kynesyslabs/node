import { ILike, LessThan, MoreThan, QueryFailedError } from "typeorm"
import log from "src/utilities/logger"
import Block from "./block"
import Mempool from "./mempool_v2"
import Transaction from "./transaction"
import Datasource from "src/model/datasource"
import { Blocks } from "src/model/entities/Blocks"
import { IdentityCommitment } from "src/model/entities/GCRv2/IdentityCommitment"
import { getSharedState } from "src/utilities/sharedState"
import { updateMerkleTreeAfterBlock } from "@/features/zk/merkle/updateMerkleTreeAfterBlock"
import { handleError } from "src/errors"
import { getBlocksRepo, getTransactionsRepo } from "./chainDb"
import { persistConfirmedTransactionProjection } from "./chainTransactions"
import type { FindManyOptions } from "typeorm"

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
        const lastBlock = await getLastBlock()
        return lastBlock ? lastBlock.number : 0
    }
    return getSharedState.lastBlockNumber
}

export async function getLastBlockHash() {
    if (!getSharedState.lastBlockHash) {
        const lastBlock = await getLastBlock()
        return lastBlock ? lastBlock.hash : null
    }
    return getSharedState.lastBlockHash
}

export async function getLastBlockTransactionSet(): Promise<Set<string>> {
    const lastBlock = await getLastBlock()
    return new Set(lastBlock.content.ordered_transactions)
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
    return await getBlocksRepo().findOneBy({ hash: ILike(hash) })
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
    operations: any[] = [],
    position?: number,
    cleanMempool = true,
): Promise<Blocks> {
    const blocksRepo = getBlocksRepo()
    const transactionsRepo = getTransactionsRepo()
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

    let existingBlock = null
    log.info(
        "[ChainDB] [ INFO ]: Checking if block with hash " +
            block.hash +
            " already exists",
    )

    const now = Date.now()
    existingBlock = await blocksRepo.findOneBy({
        hash: ILike(block.hash),
    })
    const after = Date.now()
    log.only(
        `[ChainDB] [ INFO ]: Block ${block.hash} found in ${after - now}ms`,
    )

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

    const transactionEntities = await Mempool.getTransactionsByHashes(
        orderedTransactionsHashes,
    )

    const db = await Datasource.getInstance()
    const dataSource = db.getDataSource()

    try {
        const now2 = Date.now()
        const result = await dataSource.transaction(
            async transactionalEntityManager => {
                const savedBlock = await transactionalEntityManager.save(
                    blocksRepo.target,
                    newBlock,
                )

                const now3 = Date.now()
                log.only(
                    `[ChainDB] [ INFO ]: Block ${block.hash} saved in ${now3 - now2}ms`,
                )

                const queryRunner = transactionalEntityManager.queryRunner
                for (let i = 0; i < transactionEntities.length; i++) {
                    const tx = transactionEntities[i]
                    const savepoint = `tx_insert_${i}`

                    await queryRunner.query(`SAVEPOINT ${savepoint}`)
                    try {
                        const rawTransaction = Transaction.toRawTransaction(
                            tx,
                            "confirmed",
                        )
                        await transactionalEntityManager.save(
                            transactionsRepo.target,
                            rawTransaction,
                        )
                        await persistConfirmedTransactionProjection(
                            tx,
                            block.number,
                            transactionalEntityManager,
                        )
                        await queryRunner.query(
                            `RELEASE SAVEPOINT ${savepoint}`,
                        )
                    } catch (error) {
                        await queryRunner.query(
                            `ROLLBACK TO SAVEPOINT ${savepoint}`,
                        )
                        if (error instanceof QueryFailedError) {
                            log.error(
                                `[ChainDB] [ ERROR ]: Failed to insert transaction ${tx.hash}. Skipping it ...`,
                            )
                            log.error(`Message: ${error.message}`)
                            continue
                        }

                        log.error(
                            "Unexpected error while inserting tx: " + tx.hash,
                        )
                        handleError(error, "CHAIN", {
                            source: "transaction insertion",
                        })
                        throw error
                    }
                }

                const now4 = Date.now()
                log.only(
                    `[ChainDB] [ INFO ]: ${transactionEntities.length} transactions inserted in ${now4 - now3}ms`,
                )

                if (cleanMempool) {
                    await Mempool.removeTransactionsByHashes(
                        transactionEntities.map(tx => tx.hash),
                        transactionalEntityManager,
                    )
                }

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

                return savedBlock
            },
        )

        const after2 = Date.now()
        log.only(
            `[ChainDB] Block insert ops ${block.hash} completed in ${after2 - now2}ms`,
        )
        if (block.number > getSharedState.lastBlockNumber) {
            getSharedState.lastBlockNumber = block.number
            getSharedState.lastBlockHash = block.hash
        }

        log.debug(
            "[insertBlock] lastBlockNumber: " + getSharedState.lastBlockNumber,
        )
        log.debug(
            "[insertBlock] lastBlockHash: " + getSharedState.lastBlockHash,
        )

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
