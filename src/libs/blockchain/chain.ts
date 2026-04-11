/* eslint-disable no-unused-vars */
/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { Repository } from "typeorm"
import Block from "./block"
import { Peer } from "../peer"
import Transaction from "./transaction"
import { Blocks } from "src/model/entities/Blocks"
import { Transactions } from "src/model/entities/Transactions"
import { GCRExtended } from "src/model/entities/GCR/GlobalChangeRegistry"
import { GlobalChangeRegistry } from "src/model/entities/GCR/GlobalChangeRegistry"
import type { Operation } from "@kynesyslabs/demosdk/types"
import type { TransactionContent } from "@kynesyslabs/demosdk/types"

import {
    setupChainDb,
    readSql,
    writeSql,
    getBlocksRepo,
    getTransactionsRepo,
} from "./chainDb"
import * as blockOps from "./chainBlocks"
import * as txOps from "./chainTransactions"
import * as genesisOps from "./chainGenesis"
import * as statusOps from "./chainStatus"
import log from "src/utilities/logger"

/**
 * Chain facade — delegates to focused sub-modules:
 *   chainDb.ts          — DB setup, raw SQL
 *   chainBlocks.ts      — block queries, insertBlock, maintenance
 *   chainTransactions.ts — tx queries, insertTransaction
 *   chainGenesis.ts     — genesis block generation
 *   chainStatus.ts      — statusOf, statusHashAt
 */
export default class Chain {
    static blocks: Repository<Blocks>
    static transactions: Repository<Transactions>

    // ── DB setup ──────────────────────────────────────────────
    static async setup() {
        await setupChainDb()
        this.blocks = getBlocksRepo()
        this.transactions = getTransactionsRepo()
    }

    static async read(sqlQuery: string): Promise<any> {
        return readSql(sqlQuery)
    }

    static async write(sqlQuery: string) {
        return writeSql(sqlQuery)
    }

    // ── Block queries ─────────────────────────────────────────
    static isGenesis(block: Block): boolean {
        return blockOps.isGenesis(block)
    }

    static async getLastBlock(): Promise<Blocks> {
        return blockOps.getLastBlock()
    }

    static async getLastBlockNumber(): Promise<number> {
        return blockOps.getLastBlockNumber()
    }

    static async getLastBlockHash() {
        return blockOps.getLastBlockHash()
    }

    static async getLastBlockTransactionSet(): Promise<Set<string>> {
        return blockOps.getLastBlockTransactionSet()
    }

    static async getBlocks(
        start: "latest" | number,
        limit: number,
    ): Promise<Blocks[]> {
        return blockOps.getBlocks(start, limit)
    }

    static async getBlockByNumber(number: number): Promise<Blocks> {
        return blockOps.getBlockByNumber(number)
    }

    static async getBlockByHash(hash: string): Promise<Blocks> {
        return blockOps.getBlockByHash(hash)
    }

    static async getGenesisBlock(): Promise<Blocks> {
        return blockOps.getGenesisBlock()
    }

    static async getGenesisBlockHash(): Promise<string> {
        return blockOps.getGenesisBlockHash()
    }

    static async getOnlinePeersForLastThreeBlocks(): Promise<Peer[]> {
        return blockOps.getOnlinePeersForLastThreeBlocks()
    }

    // ── Transaction queries ───────────────────────────────────
    static async getTxByHash(hash: string): Promise<Transaction | null> {
        return txOps.getTxByHash(hash)
    }

    static async getTransactionHistory(
        address: string,
        txtype: TransactionContent["type"] | "all",
        start = 0,
        limit = 100,
    ) {
        return txOps.getTransactionHistory(address, txtype, start, limit)
    }

    static async getBlockTransactions(
        blockHash: string,
    ): Promise<Transaction[]> {
        return txOps.getBlockTransactions(blockHash)
    }

    static async getTransactionFromHash(
        hash: string,
    ): Promise<Transaction | null> {
        return txOps.getTransactionFromHash(hash)
    }

    static async getTransactionsFromHashes(
        hashes: string[],
    ): Promise<Transaction[]> {
        return txOps.getTransactionsFromHashes(hashes)
    }

    static async getTransactions(
        start: "latest" | number,
        limit: number,
    ): Promise<Transactions[]> {
        return txOps.getTransactions(start, limit)
    }

    static async checkTxExists(hash: string): Promise<boolean> {
        return txOps.checkTxExists(hash)
    }

    static async getExistingTransactionHashes(
        hashes: string[],
    ): Promise<Set<string>> {
        return txOps.getExistingTransactionHashes(hashes)
    }

    // ── Mutations ─────────────────────────────────────────────
    static async insertBlock(
        block: Block,
        operations: Operation[] = [],
        position?: number,
        cleanMempool = true,
    ): Promise<Blocks> {
        const now = Date.now()
        log.only(
            `[Chain] [ INFO ]: Inserting block ${block.number}`,
        )
        const res = await blockOps.insertBlock(
            block,
            operations,
            position,
            cleanMempool,
        )
        const after = Date.now()
        log.only(
            `[Chain] [ INFO ]: Block ${block.number} inserted in ${after - now}ms`,
        )
        return res
    }

    static async insertTransaction(
        transaction: Transaction,
        status = "confirmed",
    ): Promise<boolean> {
        return txOps.insertTransaction(transaction, status)
    }

    static async insertTransactionsFromSync(
        transactions: Transaction[],
    ): Promise<boolean> {
        return txOps.insertTransactionsFromSync(transactions)
    }

    // ── Genesis ───────────────────────────────────────────────
    static async generateGenesisBlock(genesisData: any): Promise<Block> {
        return genesisOps.generateGenesisBlock(genesisData)
    }

    static async generateGenesisBlocks(genesisJsons: any[]): Promise<string> {
        return genesisOps.generateGenesisBlocks(genesisJsons)
    }

    static async getGenesisUniqueBlock() {
        return genesisOps.getGenesisUniqueBlock()
    }

    // ── Status ────────────────────────────────────────────────
    static async statusOf(
        address: string,
        type: number,
    ): Promise<GlobalChangeRegistry | GCRExtended | null> {
        return statusOps.statusOf(address, type)
    }

    static async statusHashAt(blockNumber: number) {
        return statusOps.statusHashAt(blockNumber)
    }

    // ── Maintenance ───────────────────────────────────────────
    static async pruneBlocksToGenesisBlock(): Promise<void> {
        return blockOps.pruneBlocksToGenesisBlock()
    }

    static async nukeGenesis(): Promise<void> {
        return blockOps.nukeGenesis()
    }

    static async updateGenesisTimestamp(newTimestamp: number): Promise<void> {
        return blockOps.updateGenesisTimestamp(newTimestamp)
    }
}
