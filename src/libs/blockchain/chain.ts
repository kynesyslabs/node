/* eslint-disable no-unused-vars */
/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import {
    MoreThan,
    ILike,
    In,
    LessThan,
    FindManyOptions,
    Repository,
} from "typeorm"

import Block from "./block"
import { Peer } from "../peer"
import Mempool from "./mempool_v2"
import log from "src/utilities/logger"
import Transaction from "./transaction"
import Hashing from "../crypto/hashing"
import Datasource from "src/model/datasource"
import { Blocks } from "src/model/entities/Blocks"
import { Operation } from "@kynesyslabs/demosdk/types"
import manageNative from "./gcr/gcr_routines/manageNative"
import { getSharedState } from "src/utilities/sharedState"
import { GCRHashes } from "src/model/entities/GCRv2/GCRHashes"
import { Transactions } from "src/model/entities/Transactions"
import type { TransactionContent } from "@kynesyslabs/demosdk/types"
import { GCRExtended } from "src/model/entities/GCR/GlobalChangeRegistry"
import { GlobalChangeRegistry } from "src/model/entities/GCR/GlobalChangeRegistry"
import getCommonValidatorSeed from "../consensus/v2/routines/getCommonValidatorSeed"
import HandleGCR from "./gcr/handleGCR"

export default class Chain {
    static blocks: Repository<Blocks>
    static transactions: Repository<Transactions>

    static async setup() {
        const db = await Datasource.getInstance()
        this.blocks = db.getDataSource().getRepository(Blocks)
        this.transactions = db.getDataSource().getRepository(Transactions)
        // TODO: Refactor methods to use this.blocks and this.transactions
    }

    static async read(sqlQuery: string): Promise<any> {
        try {
            const db = await Datasource.getInstance()
            return await db.getDataSource().query(sqlQuery)
        } catch (err) {
            console.log("[ChainDB] [ ERROR ]: " + JSON.stringify(err))
            console.error(err)
            throw err
        }
    }

    static async write(sqlQuery: string) {
        try {
            const db = await Datasource.getInstance()
            return await db.getDataSource().query(sqlQuery)
        } catch (err) {
            console.log("[ChainDB] [ ERROR ]: " + JSON.stringify(err))
            console.error(err)
            throw err
        }
    }
    // SECTION Getters

    // INFO Returns a transaction by its hash
    static async getTxByHash(hash: string): Promise<Transaction> {
        try {
            return Transaction.fromRawTransaction(
                await this.transactions.findOneBy({
                    hash: ILike(hash),
                }),
            )
        } catch (error) {
            console.log("[ChainDB] [ ERROR ]: " + JSON.stringify(error))
            console.error(error)
            throw error // It does not crash the node, as it is caught by the endpoint handler
        }
    }

    static async getTransactionHistory(
        address: string,
        txtype: TransactionContent["type"] | "all",
        start = 0,
        limit = 100,
    ) {
        const whereConditions: any[] = [{ from: address }, { to: address }]

        if (txtype !== "all") {
            whereConditions[0].type = txtype
            whereConditions[1].type = txtype
        }

        const transaction = await this.transactions.find({
            where: whereConditions,
            order: {
                timestamp: "DESC",
            },
            take: limit,
            skip: start,
        })

        return transaction.map(tx => Transaction.fromRawTransaction(tx))
    }

    // INFO Get the last block number
    static async getLastBlockNumber(): Promise<number> {
        if (!getSharedState.lastBlockNumber) {
            const lastBlock = await this.getLastBlock()
            return lastBlock ? lastBlock.number : 0
        }

        return getSharedState.lastBlockNumber
    }

    // INFO Get the last block hash
    static async getLastBlockHash() {
        if (!getSharedState.lastBlockHash) {
            const lastBlock = await this.getLastBlock()
            return lastBlock ? lastBlock.hash : null
        }

        return getSharedState.lastBlockHash
    }

    // INFO returns all blocks by the given range, default from end of the table.
    /**
     * Returns <limit> blocks starting from the given block number.
     *
     * @param start The block number to start from
     * @param limit The maximum number of blocks to return
     * @returns An array of blocks
     */
    static async getBlocks(
        start: "latest" | number,
        limit: number,
    ): Promise<Blocks[]> {
        const maxLimit = 50
        const calculatedLimit = Math.min(limit, maxLimit)

        let options: FindManyOptions<Blocks> = {
            order: { number: "DESC" },
            take: calculatedLimit,
        }

        if (start !== "latest") {
            options = { ...options, where: { number: LessThan(start + 1) } }
        }

        return await this.blocks.find(options)
    }

    // INFO Get any block by its number
    static async getBlockByNumber(number: number): Promise<Blocks> {
        return await this.blocks.findOneBy({ number })
    }

    // INFO Get any block by its hash
    static async getBlockByHash(hash: string): Promise<Blocks> {
        return await this.blocks.findOneBy({ hash: ILike(hash) })
    }

    static async getGenesisBlock(): Promise<Blocks> {
        return await this.getBlockByNumber(0)
    }

    static async getGenesisBlockHash(): Promise<string> {
        const genesisBlock = await this.blocks.findOne({
            where: { number: 0 },
            select: { hash: true },
        })

        return genesisBlock ? genesisBlock.hash : null
    }

    // ANCHOR Transactions
    static async getTransactionFromHash(hash: string): Promise<Transaction> {
        return Transaction.fromRawTransaction(
            await this.transactions.findOneBy({ hash: ILike(hash) }),
        )
    }

    // INFO returns transactions by hashes
    static async getTransactionsFromHashes(
        hashes: string[],
    ): Promise<Transaction[]> {
        const rawTransactions = await this.transactions.find({
            where: { hash: In(hashes) },
        })

        return rawTransactions.map(rawTransaction =>
            Transaction.fromRawTransaction(rawTransaction),
        )
    }

    // INFO returns all transactions by the given range, default from end of the table.
    /**
     * Returns <limit> transactions starting from the given transaction id.
     *
     * @param start The transaction id to start from
     * @param limit The maximum number of transactions to return
     * @returns An array of transactions
     */
    static async getTransactions(
        start: "latest" | number,
        limit: number,
    ): Promise<Transactions[]> {
        const maxLimit = 100
        const calculatedLimit = Math.min(limit, maxLimit)

        let options: FindManyOptions<Transactions> = {
            order: { id: "DESC" },
            take: calculatedLimit,
        }

        if (start !== "latest") {
            options = { ...options, where: { id: LessThan(start + 1) } }
        }

        return await this.transactions.find(options)
    }

    static async checkTxExists(hash: string): Promise<boolean> {
        return await this.transactions.exists({ where: { hash: hash } })
    }

    // REVIEW Giving back all the properties of an address

    static isGenesis(block: Block): boolean {
        // Check if there are any ordered transactions
        if (block.number === 0) {
            return true
        }
    }

    static async getLastBlock(): Promise<Blocks> {
        if (!getSharedState.lastBlockNumber) {
            return await this.blocks
                .createQueryBuilder("block")
                .orderBy("block.number", "DESC")
                .limit(1)
                .getOne()
        }

        return await this.getBlockByNumber(getSharedState.lastBlockNumber)
    }

    // ! FIXME Rewrite this to return a peer list
    static async getOnlinePeersForLastThreeBlocks(): Promise<Peer[]> {
        const lastBlockNumber = await this.getLastBlockNumber()

        if (lastBlockNumber < 3) {
            return []
        }

        const blocks = await this.getBlocks("latest", 3)

        try {
            const processedBlocks = await Promise.all(
                blocks.map(async block => {
                    const transactions = await this.getTransactionsFromHashes(
                        block.content.ordered_transactions,
                    )

                    // Filter NODE_ONLINE transactions and extract their data
                    const onlinePeersInBlockTransactions = transactions
                        .filter(
                            transaction =>
                                transaction?.content.type === "NODE_ONLINE",
                        )
                        .map(
                            transaction =>
                                (transaction?.content as TransactionContent)
                                    .data,
                        )

                    // Extract the peer list from the transactions
                    const onlinePeersInBlock =
                        onlinePeersInBlockTransactions.map(onlineTxRaw => {
                            const onlineTx = JSON.parse(onlineTxRaw[0])
                            return onlineTx.data as Peer
                        })

                    return onlinePeersInBlock
                }),
            )

            // Find common peers across blocks
            const commonPeers = processedBlocks.reduce(
                (common, peersInBlock) => {
                    return common.filter(peer => peersInBlock.includes(peer))
                },
                processedBlocks[0] || [],
            )

            return commonPeers
        } catch (e) {
            return []
        }
    }

    // !SECTION Getters

    // SECTION  Setters
    // INFO Insert a block into the database
    // NOTE Inserting a block is done after the consensus, so that together
    // with the block, we can write the GCR status changes to the chain.
    static async insertBlock(
        block: Block,
        operations: Operation[] = [],
        position?: number,
        cleanMempool = true,
    ): Promise<Blocks> {
        log.info(
            "[insertBlock] Attempting to insert a block with hash: " +
                block.hash,
        )
        // Convert the transactions strings back to Transaction objects
        log.info("[insertBlock] Extracting transactions from block")
        // ! FIXME The below fails when a tx like a web2Request is inserted
        const orderedTransactionsHashes = block.content.ordered_transactions
        log.info(JSON.stringify(orderedTransactionsHashes))
        // Fetch transaction entities from the repository based on ordered transaction hashes
        const transactionEntities = await Mempool.getTransactionsByHashes(
            orderedTransactionsHashes,
        )

        const newBlock = new Blocks()
        log.info("[CHAIN] reading hash")
        log.info(JSON.stringify(transactionEntities))
        log.info("[CHAIN] bork")

        newBlock.hash = block.hash
        newBlock.number = block.number
        newBlock.proposer = block.proposer
        newBlock.next_proposer = block.next_proposer
        newBlock.status = block.status
        newBlock.validation_data = block.validation_data
        newBlock.content = block.content
        newBlock.status = "confirmed"
        newBlock.content.ordered_transactions = transactionEntities.map(
            tx => tx.hash,
        )

        // Check if the position is provided and if a block with that position exists
        let existingBlock = null
        log.info(
            "[ChainDB] [ INFO ]: Checking if block with hash " +
                block.hash +
                " already exists",
        )
        if (position) {
            log.info("Block has a position passed as arg")
            existingBlock = await this.blocks.findOneBy({
                hash: ILike(block.hash),
            })
        } else {
            log.info(
                "[ChainDB] [ INFO ]: Found block with null hash, possibly genesis block",
            )
        }

        if (existingBlock) {
            log.info(
                "[ChainDB] [ INFO ]: Block with position " +
                    position +
                    " does exist: updating a new block",
            )
            // Update the existing block
            existingBlock.content = block.content
            existingBlock.number = block.number
            existingBlock.hash = block.hash
            existingBlock.status = block.status
            existingBlock.proposer = block.proposer
            existingBlock.validation_data = block.validation_data
            log.info("about to save block")
            return await this.blocks.save(existingBlock)
        } else {
            log.info(
                "[ChainDB] [ INFO ]: Block with position " +
                    position +
                    " does not exist: inserting a new block",
            )
            const result = await this.blocks.save(newBlock)
            getSharedState.lastBlockNumber = block.number
            getSharedState.lastBlockHash = block.hash

            log.debug(
                "[insertBlock] lastBlockNumber: " +
                    getSharedState.lastBlockNumber,
            )
            log.debug(
                "[insertBlock] lastBlockHash: " + getSharedState.lastBlockHash,
            )
            // REVIEW We then add the transactions to the Transactions repository
            for (let i = 0; i < transactionEntities.length; i++) {
                const tx = transactionEntities[i]
                await this.insertTransaction(tx)
            }
            // REVIEW And we clean the mempool
            if (cleanMempool) {
                await Mempool.removeTransactionsByHashes(
                    transactionEntities.map(tx => tx.hash),
                )
            }
            return result
        }
    }

    // INFO Generate the genesis block
    static async generateGenesisBlock(genesisData: any): Promise<Block> {
        // TODO Add a type for the block json
        const genesisBlock = new Block()
        genesisBlock.number = 0

        // Define the genesis transaction
        const genesisTx = new Transaction()
        genesisTx.content.type = "genesis"
        genesisTx.blockNumber = 0
        genesisTx.content.to = {
            type: getSharedState.signingAlgorithm,
            data: new Uint8Array(Buffer.from("0x0", "hex")),
        }.data.toString()
        genesisTx.content.from = {
            type: getSharedState.signingAlgorithm,
            data: new Uint8Array(Buffer.from("0x0", "hex")),
        }.data.toString()

        genesisTx.signature = {
            type: getSharedState.signingAlgorithm,
            data: "0x0",
        }
        genesisTx.status = "confirmed"

        if (!genesisData.timestamp) {
            genesisTx.content.timestamp = Date.now()
        } else {
            genesisTx.content.timestamp = parseInt(genesisData.timestamp)
        }
        genesisTx.content.amount = 0
        genesisTx.content.nonce = 0
        genesisTx.content.transaction_fee.network_fee = 0
        genesisTx.content.transaction_fee.rpc_fee = 0
        genesisTx.content.transaction_fee.additional_fee = 0

        genesisTx.hash = Hashing.sha256(JSON.stringify(genesisTx.content))

        // Build a block containing the genesis tx
        genesisBlock.content.timestamp = genesisTx.content.timestamp
        genesisBlock.content.ordered_transactions.push(genesisTx.hash)
        genesisBlock.content.previousHash = "0x0"
        genesisBlock.content["extra"] = {
            genesisData: JSON.stringify(genesisData),
        }
        genesisBlock.status = "confirmed"
        genesisBlock.proposer = "0x000000000000000000000000"
        genesisBlock.content.encrypted_transactions_hashes = new Map()
        genesisBlock.validation_data = {
            signatures: {
                "0x000000000000000000000000": "0x0",
            },
        }
        genesisBlock.hash = Hashing.sha256(JSON.stringify(genesisBlock.content))

        const { commonValidatorSeed } = await getCommonValidatorSeed(
            genesisBlock as any,
        )
        genesisBlock.next_proposer = commonValidatorSeed

        // REVIEW Create a GCR Operation and execute it
        const genesisOp: Operation = {
            operator: "genesis",
            actor: "DEMOS Network",
            params: genesisData,
            hash: genesisBlock.hash,
            nonce: 0,
            timestamp: genesisBlock.content.timestamp,
            status: true,
            fees: {
                network_fee: 0,
                rpc_fee: 0,
                additional_fee: 0,
            },
        }
        // Insert the genesis block into the database
        //console.log(genesis_block)
        console.log("[GENESIS] Block generated, ready to insert it")
        // console.log(genesisBlock)
        console.log("[GENESIS] inserting transaction into the mempool")
        // console.log(genesisTx)
        //await this.insertTransaction(genesis_tx)
        await Mempool.addTransaction({ ...genesisTx, reference_block: 0 }) // ! FIXME This fails
        console.log("[GENESIS] inserted transaction")

        // SECTION: Restoring account data
        const users = {}

        // INFO: Create genesis users
        for (const balance of genesisData.balances) {
            const user = {
                pubkey: balance[0],
                balance: balance[1],
            }
            users[user.pubkey] = user
        }

        // INFO: Update genesis users with existing balances
        for (const user of genesisData?.users || []) {
            // If the user is already indexed, use existing balance
            const balance = users[user.pubkey]?.balance || 0n

            users[user.pubkey] = {
                ...user,
                balance: balance,
            }
        }

        const userAccounts: Record<string, any>[] = Object.values(users)
        console.log("total users: " + userAccounts.length)

        // INFO: Create all users in parallel batches
        const batchSize = 100
        for (let i = 0; i < userAccounts.length; i += batchSize) {
            const batch = userAccounts.slice(i, i + batchSize)
            log.info(
                `[GENESIS] Processing batch ${
                    Math.floor(i / batchSize) + 1
                }/${Math.ceil(userAccounts.length / batchSize)} (${
                    batch.length
                } accounts)`,
            )

            // Process all accounts in the current batch concurrently
            await Promise.all(
                batch.map(async user => {
                    await HandleGCR.createAccount(user.pubkey, user)
                }),
            )
        }

        // !SECTION Restoring account data

        await this.insertBlock(genesisBlock, [genesisOp], 0)
        return genesisBlock
    }

    // INFO Generates multiple genesis blocks from an array of genesis configurations and inserts them into the chain
    static async generateGenesisBlocks(genesisJsons: any[]): Promise<string> {
        const compiledBlock = ""
        // TODO
        return compiledBlock
    }

    // INFO Searches all the genesis blocks and returns an artifact representing the current chain genesis
    static async getGenesisUniqueBlock() {
        // TODO
    }

    // INFO Insert a transaction into the database
    static async insertTransaction(
        transaction: Transaction,
        status = "confirmed",
    ): Promise<boolean> {
        console.log(
            "[insertTransaction] Inserting transaction: " + transaction.hash,
        )
        const rawTransaction = Transaction.toRawTransaction(transaction, status)
        console.log("[insertTransaction] Raw transaction: ")
        console.log(rawTransaction)
        try {
            await this.transactions.save(rawTransaction)
            return true
        } catch (e) {
            log.error(
                "[insertTransaction] Error inserting transaction (" +
                    transaction.hash +
                    "): " +
                    e,
            )
            return false
        }
    }

    // Wrapper for inserting multiple transactions
    static async insertTransactions(
        transactions: Transaction[],
    ): Promise<boolean> {
        let success = true
        for (const tx of transactions) {
            success = await this.insertTransaction(tx)
            if (!success) {
                return false
            }
        }
        return success
    }
    // !SECTION Setters

    // SECTION Specific operations
    // INFO Getting the status of a given address either from the native or the properties table
    static async statusOf(
        address: string,
        type: number,
    ): Promise<GlobalChangeRegistry | GCRExtended | null> {
        if (type === 0) {
            const db = await Datasource.getInstance()
            const gcrRepository = db
                .getDataSource()
                .getRepository(GlobalChangeRegistry)

            return (await gcrRepository.findOneBy({
                publicKey: ILike(address),
            })) as GlobalChangeRegistry
        } else if (type === 1) {
            const db = await Datasource.getInstance()
            const gcrRepository = db
                .getDataSource()
                .getRepository(GlobalChangeRegistry)

            return (await gcrRepository.findOneBy({
                publicKey: ILike(address),
            })) as GlobalChangeRegistry
        }
        return null
    } // TODO Implement specific time-saving operations to get specific data (see the tables in the db)
    // INFO Getting the hash of the status at a given block
    static async statusHashAt(blockNumber: number) {
        const db = await Datasource.getInstance()
        const gcrHashesRepository = db.getDataSource().getRepository(GCRHashes)

        const gcrHashesSearch = await gcrHashesRepository.findOneBy({
            block: blockNumber,
        })
        return gcrHashesSearch ? gcrHashesSearch.hash : null
    }
    // !SECTION Maintennance operations

    static async pruneBlocksToGenesisBlock(): Promise<void> {
        await this.blocks.delete({ number: MoreThan(0) })
        console.log("Pruned all blocks except the genesis block.")
    }

    static async nukeGenesis(): Promise<void> {
        await this.blocks.delete({ number: 0 })
        console.log("Deleted the genesis block.")
    }

    static async updateGenesisTimestamp(newTimestamp: number): Promise<void> {
        const genesisBlock = await this.blocks.findOneBy({ number: 0 })
        if (genesisBlock) {
            // Update the timestamp in the content field
            genesisBlock.content = {
                ...genesisBlock.content,
                timestamp: newTimestamp,
            }
            await this.blocks.save(genesisBlock)
            console.log("Updated the timestamp of the genesis block.")
        }
    }
}
