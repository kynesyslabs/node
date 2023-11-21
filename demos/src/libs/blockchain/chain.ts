/* eslint-disable no-unused-vars */
/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import Block from "./blocks"
import Transaction from "./transaction"
import Hashing from "../crypto/hashing"
import Datasource from "src/model/datasource"
import { Operation } from "./gls/gls"

import { Blocks } from "src/model/entities/Blocks"
import { Transactions } from "src/model/entities/Transactions"
import RawTransaction from "./types/rawTransaction"
import { StatusNative } from "src/model/entities/StatusNative"
import { StatusProperties } from "src/model/entities/StatusProperties"
import { StatusHashes } from "src/model/entities/StatusHashes"
import StatusNativeType from "./types/statusNative"
import AddressInfo from "./types/addressInfo"
import StatusPropertiesType from "./types/statusProperties"
import { MoreThan } from "typeorm"

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
    static async getTxByHash(hash: string): Promise<Transactions> {
        const db = await Datasource.getInstance()
        const transactionRepository = db
            .getDataSource()
            .getRepository(Transactions)

        return await transactionRepository.findOneBy({
            hash,
        })
    }

    // INFO Get the last block number
    static async getLastBlockNumber(): Promise<number> {
        const db = await Datasource.getInstance()
        const blockRepository = db.getDataSource().getRepository(Blocks)
        const lastBlock = await blockRepository.findOne({
            order: { number: "DESC" },
        })
        return lastBlock ? lastBlock.number : 0
    }
    // INFO Get the last block hash
    static async getLastBlockHash() {
        const db = await Datasource.getInstance()
        const blockRepository = db.getDataSource().getRepository(Blocks)
        const lastBlock = await blockRepository.findOne({
            order: { number: "DESC" },
            select: ["hash"],
        })

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
        return await blockRepository.findOneBy({ hash })
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
        // Playground for async testing
        const db = await Datasource.getInstance()
        const blockRepository = db.getDataSource().getRepository(Blocks)
        console.log(blockRepository) // Log the repository to check its properties

        try {
            const allBlocks = await blockRepository.find()
            console.log(allBlocks) // Log all records from the table
        } catch (error) {
            console.error(error) // Log any error that occurs
        }
        let genBlock = await blockRepository.findOneBy({ number: 0 })
        console.log("genesis Block")
        console.log(genBlock)
        return genBlock
    }

    // INFO Get the current pending transactions pool
    static async getPendingPool(): Promise<RawTransaction[]> {
        const db = await Datasource.getInstance()
        const transactionRepository = db
            .getDataSource()
            .getRepository(Transactions)
        return await transactionRepository.findBy({
            status: "pending",
        })
    }

    // ANCHOR Transactions
    static async getTransactionFromHash(hash: string): Promise<RawTransaction> {
        const db = await Datasource.getInstance()
        const transactionRepository = db
            .getDataSource()
            .getRepository(Transactions)
        return await transactionRepository.findOneBy({ hash })
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
            address,
        })) as StatusNativeType
        const propertiesState = (await propertiesStateRepository.findOneBy({
            address,
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
        const lastBlock = await blockRepository.findOne({
            order: { number: "DESC" },
        })

        return lastBlock
    }

    static async getOnlinePeersForLastThreeBlocks(): Promise<
        [string, string][]
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
            return blocks.reduce(
                (commonPeers, block) => {
                    // Extract all data from transactions of type "NODE_ONLINE" in the block
                    const onlinePeersInBlock =
                        block.content.ordered_transactions
                            .filter(
                                transaction =>
                                    transaction.content.type === "NODE_ONLINE",
                            )
                            .map(transaction => transaction.content.data)

                    // Return peers that are present in both commonPeers and onlinePeersInBlock
                    return commonPeers.filter(peer =>
                        onlinePeersInBlock.includes(peer),
                    )
                },
                blocks[0].content.ordered_transactions
                    .filter(
                        transaction =>
                            transaction.content.type === "NODE_ONLINE",
                    )
                    .map(transaction => transaction.content.data),
            )
        } catch (e) {
            return []
        }
    }

    // !SECTION Getters

    // SECTION  Setters
    // INFO Insert a block into the database
    // NOTE Inserting a block is done after the consensus, so that together
    // with the block, we can write the GLS status changes to the chain.
    static async insertBlock(
        block: Block,
        operations: Operation[] = [],
        position: number = null,
    ): Promise<any> {
        const db = await Datasource.getInstance()
        const blockRepository = db.getDataSource().getRepository(Blocks)

        // Check if the position is provided and if a block with that position exists
        let existingBlock = null
        console.log(
            "[ChainDB] [ INFO ]: Checking if block with position " +
                position +
                " already exists",
        )
        if (position !== null) {
            console.log("Block does not have null position")
            existingBlock = await blockRepository.findOneBy({
                number: position,
            })
        } else {
            console.log(
                "[ChainDB] [ INFO ]: Found block with null position, possibly genesis block",
            )
        }

        if (existingBlock) {
            console.log(
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
            console.log("about to save block")
            return await blockRepository.save(existingBlock)
        } else {
            console.log(
                "[ChainDB] [ INFO ]: Block with position " +
                    position +
                    " does not exist: inserting a new block",
            )
            // Insert a new block
            let result = await blockRepository.save(block)
            console.log(result)
            return result
        }
    }

    // INFO Generate the genesis block
    static async generateGenesisBlock(genesis_data: any): Promise<Block> {
        // TODO Add a type for the block json
        console.log(genesis_data)
        let genesis_block = new Block()
        genesis_block.number = 0
        // Define the genesis transaction
        let genesis_tx = new Transaction()
        genesis_tx.content.type = "genesis"
        console.log("genesis_tx.content.data")
        console.log(genesis_tx.content.data)
        genesis_tx.hash = Hashing.sha256(JSON.stringify(genesis_tx.content))
        if (!genesis_data.timestamp) {
            genesis_tx.content.timestamp = Date.now()
        } else {
            genesis_tx.content.timestamp = genesis_data.timestamp
        }
        console.log(genesis_tx)
        // Build a block containing the genesis tx
        genesis_block.content.timestamp = genesis_tx.content.timestamp
        genesis_block.content.ordered_transactions.push(genesis_tx)
        genesis_block.content.previousHash = "0x0"
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
        console.log(genesis_block)
        console.log("[GENESIS] Block generated, ready to insert it")
        return await this.insertBlock(genesis_block, [genesis_op])
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
                address,
            })) as StatusNativeType
        } else if (type === 1) {
            const db = await Datasource.getInstance()
            const statusPropertiesRepository = db
                .getDataSource()
                .getRepository(StatusProperties)

            return (await statusPropertiesRepository.findOneBy({
                address,
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
