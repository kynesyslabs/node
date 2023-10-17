/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

// TODO genesis.json: see how it is stored on chain and make a method to
// TODO insert it in the gls automatically so that the parameters of the
// TODO chain are both immutable and editable at the same time

import Chain from "../chain"
import Token from "./types/Token"
import NFT from "./types/NFT"
import * as express from "express"
import { TxFee } from "../types/transactions"
import executeOperations from "../routines/executeOperations"
import { Actor } from "../routines/executeOperations"
import * as fs from "fs"
var term = require("terminal-kit").terminal
import Hashing from "src/libs/crypto/hashing"

export interface OperationResult {
    success: boolean
    message: string
}

export interface Operation {
    operator: string
    actor: string
    params: {} // Documented in the chain itself
    hash: string
    nonce: number
    timestamp: number
    status: boolean | "pending"
    fees: TxFee
}

// WIP Making 'operations' registry more stable through db writing or file writing
interface OperationRegistrySlot {
    operation: Operation
    status: boolean | "pending"
    result: OperationResult
    timestamp: number
}

export class OperationsRegistry {
    path: string = "data/operations.json"
    operations: OperationRegistrySlot[] = []

    constructor() {
        // Creating an empty registry if it doesn't exist
        if (!fs.existsSync(this.path)) fs.writeFileSync(this.path, "[]")
        this.operations = JSON.parse(fs.readFileSync(this.path).toString())
    }

    // INFO Adding an operation to the registry
    add(operation: Operation) {
        this.operations.push({
            operation: operation,
            status: "pending",
            result: {
                success: false,
                message: "ot yet processed",
            },
            timestamp: Date.now(),
        })
        fs.writeFileSync(this.path, JSON.stringify(this.operations))
    }

    // INFO Getting the full list of operations currently in the registry
    get(): OperationRegistrySlot[] {
        return this.operations
    }
}

// INFO Besides the static methods, the GLS store all the operations to be done in the current block so that they can be executed in order
export default class GLS {
    private static instance: GLS
    operations: Operation[] // TODO It will become the above implementation

    private constructor() {
        this.operations = []
    }

    // Singleton logic
    static getInstance(): GLS {
        if (!this.instance) {
            this.instance = new GLS()
        }
        return this.instance
    }

    // NOTE Due to the complexity of this method, it is imported by the appropriate module
    async executeOperations(): Promise<Map<string, Actor>> {
        const result = await executeOperations(this.operations)
        return result
    }

    // SECTION Getters
    static async getGLSStatusHashTable() {
        return await Chain.read("SELECT * FROM status_hashes")
    }

    static async getGLSStatusNativeTable() {
        return await Chain.read("SELECT * FROM status_native")
    }
    static async getGLSStatusPropertiesTable() {
        return await Chain.read("SELECT * FROM status_properties")
    }
    static async getGLSLastHash() {
        let response = await Chain.read(
            "SELECT hash FROM status_hashes ORDER BY id DESC LIMIT 1",
        )
        return response[0]
    }
    static async getGLSNativeFor(address: string) {
        let response = await Chain.read(
            "SELECT * FROM status_native WHERE address='" + address + "'",
        )
        return response[0]
    }
    static async getGLSPropertiesFor(address: string) {
        return await Chain.read(
            "SELECT * FROM status_properties WHERE address='" + address + "'",
        )
    }

    // ANCHOR Balances retrieval

    static async getGLSNativeBalance(address: string) {
        let response = await Chain.read(
            "SELECT balance FROM status_native WHERE address='" + address + "'",
        )
        try {
            return response[0].balance
        } catch (e) {
            term.yellow("[GET BALANCE] No balance for: " + address + "\n")
            return 0
        }
    }

    static async getGLSTokenBalance(address: string, token_address: string) {
        let response = await Chain.read(
            "SELECT tokens FROM status_properties WHERE address='",
        )
        let full_tokens_balance = response[0]
        return full_tokens_balance.tokens[token_address]
    }

    static async getGLSNFTBalance(address: string, nft_address: string) {
        let response = await Chain.read(
            "SELECT nfts FROM status_properties WHERE address='",
        )
        let full_nfts_balance = response[0]
        return full_nfts_balance.nfts[nft_address]
    }

    static async getGLSGasMultiplier() {
        let response = await Chain.read(
            "SELECT gas_multiplier FROM status_properties", // TODO Implement and make it dynamic
        )
        return response[0].gas_multiplier
    }

    // SECTION Validators management

    // INFO The following getter is used to retrieve the hashed form of the sum of all the stakes at block N
    static async getGLSHashedStakes(n: number = null) {
        if (!n) {
            n = await Chain.getLastBlockNumber()
        }
        let stakes = await Chain.read(
            "SELECT * FROM validators WHERE first_seen <= " +
                n +
                " ORDER BY first_seen DESC",
        )
        // Hashing
        let total = 0
        for (let i = 0; i < stakes.length; i++) {
            total += stakes[i].stake // TODO Probably won't work but is a poc rn
        }
        return Hashing.sha256(total.toString())
    }

    // INFO The following getter is used to retrieve the list of all validators at a given block
    static async getGLSValidatorsAtBlock(blockNumber: number = null) {
        if (!blockNumber) {
            console.log("No block number provided, getting the last one")
            blockNumber = (await Chain.getLastBlock()).number
        }
        console.log("blockNumber: " + blockNumber)
        let block_nodes = await Chain.read(
            "SELECT * FROM validators WHERE valid_at<=" +
                blockNumber +
                " AND status=2 ORDER BY valid_at DESC",
        )
        if (!block_nodes) {
            return []
        }
        return block_nodes
    }

    // INFO Get a validator (or a public key anyway) status in the staking
    // NOTE While accepting a blockNumber, it defaults to the last one
    static async getGLSValidatorStatus(
        // NOTE We want the hexed string as it is stored like that on chain
        publicKeyHex: string,
        blockNumber: number = null,
    ) {
        if (!blockNumber) {
            blockNumber = await Chain.getLastBlockNumber()
        }
        // Let's see if the validator is contained within the block
        let info = await Chain.read(
            "SELECT * FROM validators" +
                " WHERE first_seen<=" +
                blockNumber +
                " AND address=" +
                publicKeyHex,
        )
        // REVIEW Better handling of errors?
        try {
            return info[0]
        } catch (e) {
            return null
        }
    }
    // !SECTION Validators management

    // !SECTION Getters

    // SECTION Setters
    static async setGLSNativeBalance(
        address: string,
        native: number,
        tx_hash: string,
    ) {
        // Updating tx list
        let tx_list = await Chain.read(
            "SELECT tx_list FROM status_native WHERE address='" + address + "'",
        )
        // Create it if it doesn't exist
        console.log(tx_list)
        if (tx_list.length === 0) {
            tx_list = [{ tx_list: "[]" }]
            await Chain.write(
                "INSERT INTO status_native(address, balance, nonce, tx_list) VALUES('" +
                    address +
                    "','0','0', '[]')",
            )
        }
        console.log(tx_list)
        tx_list = JSON.parse(tx_list[0].tx_list)
        tx_list.push(tx_hash)
        tx_list = JSON.stringify(tx_list)
        // Updating balance and tx_list on db
        let balance_response = await Chain.write(
            "UPDATE status_native SET balance=" +
                native +
                " WHERE address='" +
                address +
                "'",
        )
        let tx_list_response = await Chain.write(
            "UPDATE status_native SET tx_list='" +
                tx_list +
                "' WHERE address='" +
                address +
                "'",
        )
        // TODO Decide if we should use status_hashes too
        return [balance_response, tx_list_response]
    }

    // TODO Build objects for tokens and nfts and write setters for them

    // !SECTION Setters
}
