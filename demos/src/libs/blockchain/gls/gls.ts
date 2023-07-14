import Chain from "../chain"
import Token from "./types/Token"
import NFT from "./types/NFT"
import * as express from 'express';

export default class GLS {

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
        return response[0].balance
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
    // !SECTION Getters

	// SECTION Setters
    static async setGLSNativeBalance(address: string, native: number, tx_hash: string) {
        // Updating tx list
        let tx_list = await Chain.read(
            "SELECT tx_list FROM status_native WHERE address='" + address + "'",
        )
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
        return [balance_response, tx_list_response]
    }

    // TODO Build objects for tokens and nfts and write setters for them

	// !SECTION Setters
}