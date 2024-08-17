/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

// INFO This module exposes a set of functions that can be used to work on transactions
// NOTE It also exposes methods that will be used to process transactions

/* TODO About being gas free

NOTE: The fee is locked by the node and released when the block itself is confirmed

*/

import forge from "node-forge"

import {
    ISignature,
    RawTransaction,
    Transaction as ITransaction,
    TransactionContent,
} from "@kynesyslabs/demosdk/types"

import Cryptography from "../crypto/cryptography"
import Hashing from "../crypto/hashing"
import { compressData, decompressData } from "../utils/demostdlib"
import Confirmation from "./types/confirmation"

interface TransactionResponse {
    status: string
    code: number
    message: string
    data: {}
}

export default class Transaction implements ITransaction {
    content: TransactionContent
    signature: ISignature
    hash: string
    status: string
    blockNumber: number

    constructor() {
        this.content = {
            type: null,
            from: null,
            to: null,
            amount: null,
            data: [null, null],
            nonce: null,
            timestamp: null,
            transaction_fee: {
                network_fee: null,
                rpc_fee: null,
                additional_fee: null,
            },
        }
        this.signature = null
        this.hash = null
        this.status = null
    }

    // INFO Given a transaction, sign it with the private key of the sender
    public static sign(
        tx: Transaction,
        privateKey: forge.pki.ed25519.BinaryBuffer,
    ): any[] {
        // Check sanity of the structure of the tx object
        if (!tx.content) {
            return [false, "Missing tx.content"]
        }
        // Sign using identity.cryptography.sign(tx.content, privateKey)
        let _signature = Cryptography.sign(
            JSON.stringify(tx.content),
            privateKey,
        )
        if (!_signature) {
            return [false, "Failed to sign transaction"]
        }
        return [true, _signature]
    }

    // INFO Given a signed transaction, verify it against the address of the sender
    // Returns [result, message]
    static verify(tx: Transaction) {
        // Check sanity of the structure of the tx object
        if (!tx.content) {
            return [false, "Missing tx.content"]
        }
        if (!tx.signature) {
            return [false, "Missing tx.signature"]
        }
        // verify using identity.cryptography.verify(tx.content, tx.signature, publicKey)
        let _verified = Cryptography.verify(
            JSON.stringify(tx.content),
            tx.signature.data.toString("hex"),
            tx.content.from.toString("hex"),
        )
        return [_verified, "Result of verify()"]
    }

    // INFO Hashing the content of a transaction
    static hash(tx: Transaction): any {
        let _hash = Hashing.sha256(JSON.stringify(tx.content))
        if (!_hash) {
            return false
        } else {
            tx.hash = _hash
            return tx
        }
    }

    // INFO Compile a verification for a transaction and spit out the resulting tx
    static confirmTx(
        tx: Transaction,
        publicKey: forge.pki.ed25519.BinaryBuffer,
        privateKey: forge.pki.ed25519.BinaryBuffer,
    ) {
        console.log("[TRANSACTION]: confirmTx")
        console.log(publicKey)
        console.log(privateKey)
        console.log(tx.signature)
        let confirmed =
            this.sanityCheck(tx) && this.isCoherent(tx) && this.structured(tx)
        if (confirmed) {
            let confirmation = new Confirmation()
            confirmation.data.validator = publicKey
            confirmation.data.tx_hash_validated = tx.hash
            confirmation.signature = Cryptography.sign(
                JSON.stringify(confirmation.data),
                privateKey,
            ).toString()
            return confirmation
        } else {
            return null
        }
    }

    // INFO Checks the integrity of a transaction
    public static sanityCheck(tx: Transaction) {
        console.log(
            "[sanityCheck] Checking the sanity of the tx with hash: " + tx.hash,
        )
        //let tx_content_hash = Hashing.sha256(JSON.stringify(tx.content))
        let _result = Cryptography.verify(
            tx.hash,
            tx.signature.data.toString("hex"),
            tx.content.from.toString("hex"),
        )
        console.log("[sanityCheck] Sanity: " + _result)
        return _result
    }

    // INFO Checking if the tx is coherent to the current state of the blockchain (and the txs pending before it)
    public static isCoherent(tx: Transaction) {
        let _result = true
        console.log(
            "[isCoherent] Checking the coherence of the tx with hash: " +
                tx.hash,
        )
        let _derived_hash = Hashing.sha256(JSON.stringify(tx.content))
        console.log("[isCoherent] Derived hash: " + _derived_hash)
        _result = _derived_hash == tx.hash
        console.log("[isCoherent] Coherence: " + _result)
        return _result
    }

    // INFO Checking if a tx has all the necessary informations
    public static structured(tx: Transaction) {
        let _structured = true
        // TODO Do this
        return _structured
    }

    public static toRawTransaction(
        tx: Transaction,
        status: string = "confirmed",
    ): RawTransaction {
        console.log("[toRawTransaction] attempting to create a raw tx")
        console.log(
            "[toRawTransaction] Signature: " +
                tx.signature.data.toString("hex"),
        )
        console.log("[toRawTransaction] Block number: " + tx.blockNumber)
        console.log("[toRawTransaction] Status: " + status)
        console.log("[toRawTransaction] Hash: " + tx.hash)
        console.log("[toRawTransaction] Type: " + tx.content.type)

        // NOTE From and To can be either a string or a Buffer
        if (tx.content.to["data"]?.toString("hex")) {
            tx.content.to = tx.content.to["data"]?.toString("hex")
        }
        if (tx.content.from["data"]?.toString("hex")) {
            tx.content.from = tx.content.from["data"]?.toString("hex")
        }

        console.log("[toRawTransaction] From: " + tx.content.from)
        console.log("[toRawTransaction] To: " + tx.content.to)
        const rawTx = {
            blockNumber: tx.blockNumber,
            signature: Buffer.from(tx.signature.data as Buffer).toString("hex"),
            status: status,
            hash: tx.hash,
            content: JSON.stringify(tx.content),
            type: tx.content.type,
            to: tx.content.to,
            from: tx.content.from,
            amount: tx.content.amount,
            nonce: tx.content.nonce,
            timestamp: tx.content.timestamp,
            networkFee: tx.content.transaction_fee.network_fee,
            rpcFee: tx.content.transaction_fee.rpc_fee,
            additionalFee: tx.content.transaction_fee.additional_fee,
        }

        return rawTx
    }

    public static fromRawTransaction(rawTx: RawTransaction): Transaction {
        const tx = new Transaction()

        console.log(rawTx)

        tx.blockNumber = rawTx.blockNumber
        tx.signature = {
            type: "ed25519", // Assuming the signature type as ed25519; adjust accordingly
            data: Buffer.from(rawTx.signature, "hex"),
        }
        tx.status = rawTx.status
        tx.hash = rawTx.hash
        tx.content = {
            type: rawTx.type,
            from: Buffer.from(rawTx.from, "hex"),
            to: Buffer.from(rawTx.to, "hex"),
            amount: rawTx.amount,
            nonce: rawTx.nonce,
            timestamp: rawTx.timestamp,
            transaction_fee: {
                network_fee: rawTx.networkFee,
                rpc_fee: rawTx.rpcFee,
                additional_fee: rawTx.additionalFee,
            },

            data: JSON.parse(rawTx.content).data,
        }
        return tx
    }

    // SECTION Compression support

    public static compress(tx: Transaction): Transaction {
        let _tx = compressData(tx)
        return _tx
    }

    public static decompress(tx: Transaction): Transaction {
        let _tx = decompressData(tx)
        return _tx
    }
}
