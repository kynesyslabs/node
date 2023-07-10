// INFO This module exposes a set of functions that can be used to work on transactions
// NOTE It also exposes methods that will be used to process transactions

import Cryptography from "../crypto/cryptography"
import forge, { pki } from "node-forge"
import { TransactionContent } from "./types/transactions"

export default class Transaction {
    content: TransactionContent
    signature: pki.ed25519.BinaryBuffer
    hash: string
    confirmations: any // TODO Invent something
    state_changes: any // TODO Invent something

    constructor() {
        this.content = {
            type: null,
            from: null,
            to: null,
            amount: null,
            data: null,
        }
        this.signature = null
        this.hash = null
        this.confirmations = null
        // REVIEW Should we add state changes?
        this.state_changes = {}
    }

    // INFO Given a transaction, sign it with the private key of the sender
    static sign(tx: Transaction, privateKey: pki.ed25519.BinaryBuffer) {
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
            tx.signature,
            tx.content.from,
        )
        return [_verified, "Result of verify()"]
    }

    // INFO Checks the integrity of a transaction
    static sanityCheck(tx: Transaction) {
        let _result = true
        // TODO
        return _result
    }

    // INFO Checking if the tx is coherent to the current state of the blockchain (and the txs pending before it)
    static isCoherent(tx: Transaction) {
        let _result = true
        // TODO
        return _result
    }
}
