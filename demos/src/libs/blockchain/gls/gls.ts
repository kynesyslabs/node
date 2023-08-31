/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import Chain from "../chain"
import Token from "./types/Token"
import NFT from "./types/NFT"
import * as express from "express"
import { TxFee } from "../types/transactions"
import executeOperations from "../routines/executeOperations"
import { Actor } from "../routines/executeOperations"
import * as fs from "fs"
var term = require("terminal-kit").terminal

export interface OperationResult {
    success: boolean;
    message: string;
}

export interface Operation { 
    operator: string;
    actor: string;
    params: {}; // Documented in the chain itself
    hash: string;
    nonce: number;
    timestamp: number;
    status: boolean | "pending";
    fees: TxFee;
}

// WIP Making 'operations' registry more stable through db writing or file writing
interface OperationRegistrySlot {
    operation: Operation;
    status: boolean | "pending";
    result: OperationResult;
    timestamp: number;
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
    // !SECTION Getters

    // SECTION Setters
    static async setGLSNativeBalance(address: string, native: number, tx_hash: string) { 
        // Updating tx list
        let tx_list = await Chain.read(
            "SELECT tx_list FROM status_native WHERE address='" + address + "'",
        )
        // Create it if it doesn't exist
        console.log(tx_list)
        if (tx_list.length === 0) {
            tx_list = [{tx_list: "[]"}]
            await Chain.write("INSERT INTO status_native(address, balance, nonce, tx_list) VALUES('" + address + "','0','0', '[]')")
        }
        console.log(tx_list)
        tx_list = JSON.parse(tx_list[0].tx_list)
        tx_list.push(tx_hash)
        tx_list = JSON.stringify(tx_list)
        // Updating balance and tx_list on db
        let balance_response = await Chain.write(
            "UPDATE status_native SET balance=" + native + " WHERE address='" + address + "'",
        )
        let tx_list_response = await Chain.write(
            "UPDATE status_native SET tx_list='" + tx_list + "' WHERE address='" + address + "'",
        )
        // TODO Decide if we should use status_hashes too
        return [balance_response, tx_list_response]
    }

    // TODO Build objects for tokens and nfts and write setters for them

    // !SECTION Setters
}