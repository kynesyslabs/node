/* eslint-disable no-unused-vars */
/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import Datasource from "src/model/datasource"
import { Blocks } from "src/model/entities/Blocks"
import { StatusHashes } from "src/model/entities/StatusHashes"
import { StatusNative } from "src/model/entities/StatusNative"
import { StatusProperties } from "src/model/entities/StatusProperties"
import { Transactions } from "src/model/entities/Transactions"
import { MoreThan, ILike } from "typeorm"

import {
    AddressInfo, Operation, StatusNative as StatusNativeType,
    StatusProperties as StatusPropertiesType, TransactionContent,
} from "@kynesyslabs/demosdk/types"

import { Hashing } from "node_modules/@kynesyslabs/demosdk/build/encryption"


import Block from "./block"
import manageNative from "./routines/gls_routines/manageNative"
import Transaction from "./transaction"
import { Peer } from "../peer"
import Mempool from "./mempool"
import log from "src/utilities/logger"


export default class Chain {
    private static instance: Chain

    static getInstance(): Chain {
        if (!this.instance) {
            this.instance = new Chain()
        }
        return this.instance
    }

    static async read(sql_query: string): Promise<any> {
        try {
            const db = await Datasource.getInstance()
            return await db.getDataSource().query(sql_query)
        } catch (err) {
            console.log("[ChainDB] [ ERROR ]: " + JSON.stringify(err))
            console.error(err)
            throw err
        }
    }

    static async write(sql_query: string) {
        try {
            const db = await Datasource.getInstance()
            return await db.getDataSource().query(sql_query)
        } catch (err) {
            console.log("[ChainDB] [ ERROR ]: " + JSON.stringify(err))
            console.error(err)
            throw err
        }
    }
    // SECTION Getters

    // INFO Returns a transaction by its hash
    static async getTxByHash(hash: string): Promise<Transaction> {
        const db = await Datasource.getInstance()
        const transactionRepository = db
            .getDataSource()
            .getRepository(Transactions)
        try {
            return Transaction.fromRawTransaction(
                await transactionRepository.findOneBy({
                    hash: ILike(hash),
                }),
            )
        } catch (error) {   
            console.log("[ChainDB] [ ERROR ]: " + JSON.stringify(error))
            console.error(error)
            throw error // It does not crash the node, as it is caught by the endpoint handler
        }
    }

    // INFO Get the last block number
    static async getLastBlockNumber(): Promise<number> {
        const db = await Datasource.getInstance()
        const blockRepository = db.getDataSource().getRepository(Blocks)
        const lastBlock = await blockRepository
            .createQueryBuilder("block")
            .orderBy("block.number", "DESC")
            .getOne()

        return lastBlock ? lastBlock.number : 0
    }
    // INFO Get the last block hash
    static async getLastBlockHash() {
        const db = await Datasource.getInstance()
        const blockRepository = db.getDataSource().getRepository(Blocks)

        const lastBlock = await blockRepository
            .createQueryBuilder("block")
            .orderBy("block.number", "DESC")
            .getOne()

        return lastBlock?.hash
    }
    // INFO Get any block by its number
    static async getBlockByNumber(number: number): Promise<Blocks> {
        const db = await Datasource.getInstance()
        const blockRepository = db.getDataSource().getRepository(Blocks)
        return await blockRepository.findOneBy({ number })
    }
    // INFO Get any block by its hash
    static async getBlockByHash(hash: string): Promise<Blocks> {
        const db = await Datasource.getInstance()
        const blockRepository = db.getDataSource().getRepository(Blocks)
        return await blockRepository.findOneBy({ hash: ILike(hash) })
    }
    // INFO Get a group of blocks by their status
    static async getBlockNumbersByStatus(status: string): Promise<number[]> {
        const db = await Datasource.getInstance()
        const blockRepository = db.getDataSource().getRepository(Blocks)

        const blocks = await blockRepository.findBy({ status })
        return blocks.map(block => block.number)
    }

    // INFO Get a group of blocks by their proposer
    static async getBlockNumbersByProposer(
        proposer: string,
    ): Promise<number[]> {
        const db = await Datasource.getInstance()
        const blockRepository = db.getDataSource().getRepository(Blocks)
        const blocks = await blockRepository.findBy({ proposer })
        return blocks.map(block => block.number)
    }

    static async getGenesisBlock(): Promise<Blocks> {
        console.log("get genesis block")
        const db = await Datasource.getInstance()
        const blockRepository = db.getDataSource().getRepository(Blocks)

        let genBlock = await blockRepository.findOneBy({ number: 0 })
        console.log("[getGenesisBlock] genesis Block retrieved")
        //console.log(genBlock)
        return genBlock
    }

    // INFO Get the current pending transactions pool
    static async getPendingPool(): Promise<Transaction[]> {
        const db = await Datasource.getInstance()
        const transactionRepository = db
            .getDataSource()
            .getRepository(Transactions)
        const txList = await transactionRepository.findBy({
            status: "pending",
        })
        return txList.map(rawTx => Transaction.fromRawTransaction(rawTx))
    }

    // ANCHOR Transactions
    static async getTransactionFromHash(hash: string): Promise<Transaction> {
        const db = await Datasource.getInstance()
        const transactionRepository = db
            .getDataSource()
            .getRepository(Transactions)
        return Transaction.fromRawTransaction(
            await transactionRepository.findOneBy({ hash: ILike(hash) }),
        )
    }

    // REVIEW Giving back all the properties of an address

    static async getAddressInfo(address: string): Promise<AddressInfo> {
        const db = await Datasource.getInstance()
        const nativeStateRepository = db
            .getDataSource()
            .getRepository(StatusNative)

        const propertiesStateRepository = db
            .getDataSource()
            .getRepository(StatusProperties)

        const nativeState = (await nativeStateRepository.findOneBy({
            address: ILike(address),
        })) as StatusNativeType
        const propertiesState = (await propertiesStateRepository.findOneBy({
            address: ILike(address),
        })) as StatusPropertiesType

        return {
            native: nativeState,
            properties: propertiesState,
        }
    }

    static isGenesis(block: Block): boolean {
        // Check if there are any ordered transactions
        if (block.number === 0) {
            return true
        }
    }

    static async getLastBlock(): Promise<Blocks> {
        const db = await Datasource.getInstance()
        const blockRepository = db.getDataSource().getRepository(Blocks)
        const lastBlock = await blockRepository
            .createQueryBuilder("block")
            .orderBy("block.number", "DESC")
            .getOne()

        return lastBlock
    }

    // ! FIXME Rewrite this to return a peer list
    static async getOnlinePeersForLastThreeBlocks(): Promise<
        Peer[]
    > {
        const lastBlockNumber = await this.getLastBlockNumber()

        if (lastBlockNumber < 3) {
            return []
        }

        const blocks = await Promise.all([
            this.getBlockByNumber(lastBlockNumber),
            this.getBlockByNumber(lastBlockNumber - 1),
            this.getBlockByNumber(lastBlockNumber - 2),
        ])

        try {
            const processedBlocks = await Promise.all(
                blocks.map(async block => {
                    const transactions = await Promise.all(
                        block.content.ordered_transactions.map(txHash =>
                            this.getTransactionFromHash(txHash),
                        ),
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
                    let onlinePeersInBlock: Peer[] = []
                    for (let i = 0; i < onlinePeersInBlockTransactions.length; i++) {
                        const onlineTxRaw = onlinePeersInBlockTransactions[i]
                        const onlineTx = JSON.parse(onlineTxRaw[0])
                        // ? This typization is totally random for now
                        const onlinePeer = onlineTx.data as Peer
                        onlinePeersInBlock.push(onlinePeer)
                    }
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

    static async getAllTxs(): Promise<Transactions[]> {
        const db = await Datasource.getInstance()
        const transactionRepository = db
            .getDataSource()
            .getRepository(Transactions)
        return await transactionRepository.find()
    }

    // !SECTION Getters

    // SECTION  Setters
    // INFO Insert a block into the database
    // NOTE Inserting a block is done after the consensus, so that together
    // with the block, we can write the GLS status changes to the chain.
    static async insertBlock(
        block: Block,
        operations: Operation[] = [],
        position?: number,
    ): Promise<any> {
        const db = await Datasource.getInstance()
        const blockRepository = db.getDataSource().getRepository(Blocks)
        const transactionRepository = db
            .getDataSource()
            .getRepository(Transactions)

        log.info("[insertBlock] Attempting to insert a block with hash: " + block.hash)
        log.info("[insertBlock] Block to be inserted: ")
        log.info(JSON.stringify(block))
        // Convert the transactions strings back to Transaction objects
        log.info("[insertBlock] Extracting transactions from block")
        // ! FIXME The below fails when a tx like a web2Request is inserted
        let orderedTransactionsHashes = block.content.ordered_transactions
        log.info(JSON.stringify(orderedTransactionsHashes))  
        // Fetch transaction entities from the repository based on ordered transaction hashes
        const transactionEntities = await Promise.all(
            orderedTransactionsHashes.map(async txHash => {
                log.info("[insertBlock] Fetching transaction with hash: " + txHash)
                /*
                // Why do we look into the transactions repository? Shouldn't be in the mempool yet?
                const rawTransaction = await transactionRepository.findOneBy({
                    hash: txHash,
                }) // This returns null
                log.info("[insertBlock] Transaction fetched: ")
                log.info(rawTransaction)
                return Transaction.fromRawTransaction(rawTransaction) */
                let mempoolData = await Mempool.getMempool()
                let tx = mempoolData.transactions.find(tx => tx.hash === txHash)
                return tx
            }),
        )

        let newBlock = new Blocks()
        // Set block properties here...
        log.info("[CHAIN] reading hash")
        log.info(JSON.stringify(transactionEntities))
        log.info("[CHAIN] bork")
        newBlock.hash = block.hash
        newBlock.number = block.number
        newBlock.proposer = block.proposer
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
            existingBlock = await blockRepository.findOneBy({
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
            return await blockRepository.save(existingBlock)
        } else {
            log.info(
                "[ChainDB] [ INFO ]: Block with position " +
                    position +
                    " does not exist: inserting a new block",
            )
            let result = await blockRepository.save(newBlock)
            //log.info(result)

            // REVIEW We then add the transactions to the Transactions repository   
            for (let i = 0; i < transactionEntities.length; i++) {
                let tx = transactionEntities[i]
                await this.insertTransaction(tx)
            }
            // REVIEW And we clean the mempool
            await Mempool.clean()

            return result
        }

    }


    // INFO Generate the genesis block
    static async generateGenesisBlock(genesis_data: any): Promise<Block> {
        // TODO Add a type for the block json
        let genesis_block = new Block()
        genesis_block.number = 0

        // Define the genesis transaction
        let genesis_tx = new Transaction()
        genesis_tx.content.type = "genesis"
        genesis_tx.blockNumber = 0
        genesis_tx.content.to = {
            type: "ed25519",
            data: new Uint8Array(Buffer.from("0x0", "hex")),
        }.data.toString()
        genesis_tx.content.from = {
            type: "ed25519",
            data: new Uint8Array(Buffer.from("0x0", "hex")),
        }.data.toString()
        
        genesis_tx.signature = {
            type: "ed25519",
            data: new Uint8Array(Buffer.from("0x0", "hex")),
        }
        genesis_tx.status = "confirmed"

        if (!genesis_data.timestamp) {
            genesis_tx.content.timestamp = Date.now()
        } else {
            genesis_tx.content.timestamp = parseInt(genesis_data.timestamp)
        }
        genesis_tx.content.amount = 0
        genesis_tx.content.nonce = 0
        genesis_tx.content.transaction_fee.network_fee = 0
        genesis_tx.content.transaction_fee.rpc_fee = 0
        genesis_tx.content.transaction_fee.additional_fee = 0

        genesis_tx.hash = Hashing.sha256(JSON.stringify(genesis_tx.content))
        console.log(genesis_tx)

        // Build a block containing the genesis tx
        genesis_block.content.timestamp = genesis_tx.content.timestamp
        genesis_block.content.ordered_transactions.push(genesis_tx.hash)
        genesis_block.content.previousHash = "0x0"
        genesis_block.status = "confirmed"
        genesis_block.proposer = "0x000000000000000000000000"
        genesis_block.validation_data = "genesis"
        genesis_block.hash = Hashing.sha256(
            JSON.stringify(genesis_block.content),
        )
        
        // REVIEW Create a GLS Operation and execute it
        let genesis_op: Operation = {
            operator: "genesis",
            actor: "DEMOS Network",
            params: genesis_data,
            hash: genesis_block.hash,
            nonce: 0,
            timestamp: genesis_block.content.timestamp,
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
        console.log(genesis_block)
        console.log("[GENESIS] inserting transaction into the mempool")
        console.log(genesis_tx)
        //await this.insertTransaction(genesis_tx)
        await Mempool.addTransaction(genesis_tx) // ! FIXME This fails
        console.log("[GENESIS] inserted transaction")
        const genesisBlock = await this.insertBlock(
            genesis_block,
            [genesis_op],
            0,
        )

        // REVIEW Maybe this should be done prior to inserting the block
        // NOTE Assigning balances from the genesis block
        var allBalances = genesis_data.balances
        for (let i = 0; i < allBalances.length; i++) {
            let individualBalance = allBalances[i]
            let address = individualBalance[0]
            let balance = individualBalance[1]
            let _balanceSuccess = await manageNative.balance.setBalance(
                address,
                balance,
            )
        }

        // Adding an empty encrypted transactions list
        genesisBlock.content.encrypted_transactions = []
        return await genesisBlock
    }

    // INFO Generates multiple genesis blocks from an array of genesis configurations and inserts them into the chain
    static async generateGenesisBlocks(genesis_jsons: any[]): Promise<string> {
        let compiledBlock = ""
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
        status: string = "confirmed",
    ): Promise<boolean> {
        console.log("[insertTransaction] Inserting transaction: " + transaction.hash)
        const rawTransaction = Transaction.toRawTransaction(transaction, status)
        console.log("[insertTransaction] Raw transaction: ")
        console.log(rawTransaction)
        const db = await Datasource.getInstance()
        const transactionRepository = db
            .getDataSource()
            .getRepository(Transactions)
        try {
            await transactionRepository.save(rawTransaction)
            return true
        } catch (e) {
            log.error("[insertTransaction] Error inserting transaction (" + transaction.hash + "): " + e)
            return false
        }
    }

    // Wrapper for inserting multiple transactions
    static async insertTransactions(transactions: Transaction[]): Promise<boolean> {
        let success = true
        for (let tx of transactions) {
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
    ): Promise<StatusNativeType | StatusPropertiesType | null> {
        if (type === 0) {
            const db = await Datasource.getInstance()
            const statusNativeRepository = db
                .getDataSource()
                .getRepository(StatusNative)

            return (await statusNativeRepository.findOneBy({
                address: ILike(address),
            })) as StatusNativeType
        } else if (type === 1) {
            const db = await Datasource.getInstance()
            const statusPropertiesRepository = db
                .getDataSource()
                .getRepository(StatusProperties)

            return (await statusPropertiesRepository.findOneBy({
                address: ILike(address),
            })) as StatusPropertiesType
        }
        return null
    } // TODO Implement specific time-saving operations to get specific data (see the tables in the db)
    // INFO Getting the hash of the status at a given block
    static async statusHashAt(block_number: number) {
        const db = await Datasource.getInstance()
        const statusHashesRepository = db
            .getDataSource()
            .getRepository(StatusHashes)

        const statusHashRecord = await statusHashesRepository.findOneBy({
            block: block_number,
        })
        return statusHashRecord ? statusHashRecord.hash : null
    }
    // !SECTION Maintennance operations

    static async pruneBlocksToGenesisBlock(): Promise<void> {
        const db = await Datasource.getInstance()
        const blockRepository = db.getDataSource().getRepository(Blocks)

        await blockRepository.delete({ number: MoreThan(0) })
        console.log("Pruned all blocks except the genesis block.")
    }

    static async nukeGenesis(): Promise<void> {
        const db = await Datasource.getInstance()
        const blockRepository = db.getDataSource().getRepository(Blocks)

        await blockRepository.delete({ number: 0 })
        console.log("Deleted the genesis block.")
    }

    static async updateGenesisTimestamp(newTimestamp: number): Promise<void> {
        const db = await Datasource.getInstance()
        const blockRepository = db.getDataSource().getRepository(Blocks)

        const genesisBlock = await blockRepository.findOneBy({ number: 0 })
        if (genesisBlock) {
            // Update the timestamp in the content field
            genesisBlock.content = {
                ...genesisBlock.content,
                timestamp: newTimestamp,
            }
            await blockRepository.save(genesisBlock)
            console.log("Updated the timestamp of the genesis block.")
        }
    }
}
