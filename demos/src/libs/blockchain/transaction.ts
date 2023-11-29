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

import Cryptography from "../crypto/cryptography"
import Hashing from "../crypto/hashing"
import { pki } from "node-forge"
import { TransactionContent } from "./types/transactions"
import Confirmation from "./types/confirmation"

interface TransactionResponse {
    status: string
    code: number
    message: string
    data: {}
}

interface Signature {
    type: string
    data: pki.ed25519.BinaryBuffer
}

export default class Transaction {
    content: TransactionContent
    signature: Signature
    hash: string
    status: string
    confirmations: Confirmation[]

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
        this.confirmations = []
        this.status = null
    }

    // INFO Given a transaction, sign it with the private key of the sender
    public static sign(
        tx: Transaction,
        privateKey: pki.ed25519.BinaryBuffer,
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
            tx.signature,
            tx.content.from,
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
        publicKey: pki.ed25519.BinaryBuffer,
        privateKey: pki.ed25519.BinaryBuffer,
    ) {
        let confirmed =
            this.sanityCheck(tx) && this.isCoherent(tx) && this.structured(tx)
        if (confirmed) {
            let confirmation = new Confirmation()
            confirmation.data.validator = publicKey
            confirmation.data.tx_hash_validated = tx.hash
            confirmation.signature = Cryptography.sign(
                JSON.stringify(confirmation.data),
                privateKey,
            )
            return confirmation
        } else {
            return null
        }
    }

    // INFO Checks the integrity of a transaction
    public static sanityCheck(tx: Transaction) {
        let _result = Cryptography.verify(
            JSON.stringify(tx.content),
            tx.signature,
            tx.content.from,
        )
        return _result
    }

    // INFO Checking if the tx is coherent to the current state of the blockchain (and the txs pending before it)
    public static isCoherent(tx: Transaction) {
        let _result = true
        let _derived_hash = Hashing.sha256(JSON.stringify(tx.content))
        _result = _derived_hash !== tx.hash
        return _result
    }

    // INFO Checking if a tx has all the necessary informations
    public static structured(tx: Transaction) {
        let _structured = true
        // TODO Do this
        return _structured
    }
}
