import { LessThan, MoreThan } from "typeorm"
import log from "src/utilities/logger"
import Block from "./block"
import Mempool from "./mempool"
import Transaction from "./transaction"
import Datasource from "src/model/datasource"
import { Blocks } from "src/model/entities/Blocks"
import { Transactions } from "src/model/entities/Transactions"
import { IdentityCommitment } from "src/model/entities/GCRv2/IdentityCommitment"
import { getSharedState } from "src/utilities/sharedState"
import { updateMerkleTreeAfterBlock } from "@/features/zk/merkle/updateMerkleTreeAfterBlock"
import { CHUNK_TRANSACTIONS, chunkedInsert, getBlocksRepo } from "./chainDb"
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
    operations: any[] = [],
    position?: number,
    cleanMempool = true,
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

    let existingBlock = null
    log.info(
        "[ChainDB] [ INFO ]: Checking if block with hash " +
            block.hash +
            " already exists",
    )

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

    let transactionEntities = await Mempool.getTransactionsByHashes(
        orderedTransactionsHashes,
    )
    transactionEntities = transactionEntities.map(tx => ({
        ...tx,
        blockNumber: block.number,
    }))

    const db = await Datasource.getInstance()
    const dataSource = db.getDataSource()

    try {
        const result = await dataSource.transaction(
            async transactionalEntityManager => {
                const saveBlockStart = Date.now()
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
                        Transaction.toRawTransaction(tx, "confirmed"),
                    )

                    const { skipped } = await chunkedInsert(
                        transactionalEntityManager,
                        Transactions,
                        rawTransactions,
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
                    `[insertBlock] Insert transactions took ${insertTransactionsEnd - insertTransactionsStart}ms`,
                )

                const removeTransactionsStart = Date.now()
                if (cleanMempool) {
                    await Mempool.removeTransactionsByHashes(
                        transactionEntities.map(tx => tx.hash),
                        transactionalEntityManager,
                    )
                }
                const removeTransactionsEnd = Date.now()
                log.only(
                    `[insertBlock] Remove transactions took ${removeTransactionsEnd - removeTransactionsStart}ms`,
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

                return savedBlock
            },
        )

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
