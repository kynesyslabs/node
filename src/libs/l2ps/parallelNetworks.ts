import type { BlockContent, Transaction } from "@kynesyslabs/demosdk/types"
import type { EncryptedTransaction } from "./types"
import * as forge from "node-forge"
import Cryptography from "../crypto/cryptography"
import Hashing from "../crypto/hashing"
import { RPCResponse } from "@kynesyslabs/demosdk/types"
import { emptyResponse } from "../network/server_rpc"
import _ from "lodash"
import Peer from "../peer/Peer"
import Chain from "../blockchain/chain"
import log from "src/utilities/logger"
// SECTION L2PS Message types and interfaces

export interface L2PSMessage {
    type: "retrieve" | "retrieveAll" | "registerTx" | "registerAsPartecipant"
    data: {
        uid: string
    }
    extra: string
}

export interface L2PSRetrieveAllTxMessage extends L2PSMessage {
    type: "retrieveAll"
    data: {
        uid: string
        blockNumber: number
    }
}

export interface L2PSRegisterTxMessage extends L2PSMessage {
    type: "registerTx"
    data: {
        uid: string
        encryptedTransaction: EncryptedTransaction
    }
}

// NOTE Peer extension for L2PS
interface PeerL2PS extends Peer {
    L2PSpublicKeys: Map<string, string> // uid, public key in PEM format
}

// ANCHOR Basic L2PS implementation class

export class Subnet {
    // Multiton implementation
    private static instances: Map<string, Subnet> = new Map() // uid, subnet

    private nodes: Map<string, string> // publicKey, connectionString
    public uid: string // Hash of the public key in PEM format
    private keypair: forge.pki.rsa.KeyPair

    // One must initialize the subnet with an uid, which is the hash of the public key in PEM format
    constructor(uid: string) {
        this.uid = uid
    }

    // SECTION Multiton implementation
    public static getInstance(uid: string): Subnet {
        if (!this.instances.has(uid)) {
            this.instances.set(uid, new Subnet(uid))
        }
        return this.instances.get(uid)
    }

    // SECTION Settings methods

    // Setting a private key will also set the uid of the subnet (hash of the public key in PEM format)
    public setPrivateKey(privateKeyPEM: string): RPCResponse {
        const response: RPCResponse = _.cloneDeep(emptyResponse)
        let msg = ""
        try {
            this.keypair.privateKey = forge.pki.privateKeyFromPem(privateKeyPEM)
            this.keypair.publicKey = forge.pki.publicKeyFromPem(privateKeyPEM)
            const uid = Hashing.sha256(
                forge.pki.publicKeyToPem(this.keypair.publicKey),
            )
            if (this.uid !== uid) {
                msg =
                    "Mismatching uid: is your private key correct and your uid is the hash of the public key in PEM format?"
            }
            this.uid = uid
            response.result = 200
        } catch (error) {
            msg =
                "Could not set the private key: is it in PEM format and valid?"
            response.result = 400
        }
        response.response = msg
        response.require_reply = false
        response.extra = this.uid
        return response
    }

    public setPublicKey(publicKeyPEM: string): RPCResponse {
        const response: RPCResponse = _.cloneDeep(emptyResponse)
        let msg = ""
        try {
            this.keypair.publicKey = forge.pki.publicKeyFromPem(publicKeyPEM)
            response.result = 200
        } catch (error) {
            msg = "Could not set the public key: is it in PEM format and valid?"
            response.result = 400
        }
        response.response = msg
        response.require_reply = false
        response.extra = this.uid
        return response
    }

    // SECTION API methods

    // Getting all the transactions in a N block for this subnet
    public async getTransactions(blockNumber: number): Promise<RPCResponse> {
        const response: RPCResponse = _.cloneDeep(emptyResponse)
        response.result = 200

        const block = await Chain.getBlockByNumber(blockNumber)
        const blockContent: BlockContent = JSON.parse(block.content)
        const encryptedTransactions = blockContent.encrypted_transactions_hashes
        response.response = encryptedTransactions
        return response
    }

    public async getAllTransactions(): Promise<RPCResponse> {
        const response: RPCResponse = _.cloneDeep(emptyResponse)
        response.result = 200
        response.response = "not implemented"
        response.require_reply = false
        response.extra = "getAllTransactions not implemented"
        // TODO
        return response
    }

    // Registering a transaction in the L2PS
    public async registerTx(
        encryptedTransaction: EncryptedTransaction,
    ): Promise<RPCResponse> {
        /* Workflow:
         * We first need to check if the payload is valid by checking the hash of the encrypted transaction.
         */
        const response: RPCResponse = _.cloneDeep(emptyResponse)
        response.result = 200
        response.response = "not implemented"
        response.require_reply = false
        response.extra = "registerTx not implemented"
        // Checking if the encrypted transaction coherent
        const expectedHash = Hashing.sha256(
            encryptedTransaction.encryptedTransaction,
        ) // Hashing the encrypted transaction
        if (expectedHash != encryptedTransaction.encryptedHash) {
            response.result = 422
            response.response = "Unprocessable Entity"
            response.require_reply = false
            response.extra = "The encrypted transaction is not coherent"
            return response
        }
        // TODO Check if the transaction is already in the L2PS
        // TODO Register the transaction in the L2PS if this node is inside the L2PS (See block.content.l2ps_partecipating_nodes)
        return response
    }

    // Registering a node as partecipant in the L2PS
    public async registerAsPartecipant(peer: Peer): Promise<RPCResponse> {
        const response: RPCResponse = _.cloneDeep(emptyResponse)
        response.result = 200
        response.response = "not implemented"
        response.require_reply = false
        response.extra = "registerAsPartecipant not implemented"
        // TODO
        return response
    }

    // SECTION Local methods
    // ! These methods should go in the sdk

    // REVIEW Decrypt a transaction
    public async decryptTransaction(
        encryptedTransaction: EncryptedTransaction,
    ): Promise<Transaction> {
        if (!this.keypair || !this.keypair.privateKey) {
            log.warning(
                "[L2PS] Subnet " +
                    this.uid +
                    " has no private key, cannot decrypt transaction",
            )
            return null
        }
        // ! TODO Clean the typing of Cryptography.rsa.decrypt
        const decryptedTransactionResponse = Cryptography.rsa.decrypt(
            encryptedTransaction.encryptedTransaction,
            this.keypair.privateKey,
        )
        if (!decryptedTransactionResponse[0]) {
            log.error(
                "[L2PS] Error decrypting transaction " +
                    encryptedTransaction.hash +
                    " on subnet " +
                    this.uid,
            )
            return decryptedTransactionResponse[1]
        }
        const decryptedTransaction: Transaction =
            decryptedTransactionResponse[1]
        return decryptedTransaction
    }

    // REVIEW Implement a public key encryption method for the L2PS
    public async encryptTransaction(
        transaction: Transaction,
    ): Promise<EncryptedTransaction> {
        if (!this.keypair || !this.keypair.publicKey) {
            log.warning(
                "[L2PS] Subnet " +
                    this.uid +
                    " has no public key, cannot encrypt transaction",
            )
            return null
        }
        // ! TODO Clean the typing of Cryptography.rsa.encrypt
        const encryptedTransactionResponse = Cryptography.rsa.encrypt(
            JSON.stringify(transaction),
            this.keypair.publicKey,
        )
        if (!encryptedTransactionResponse[0]) {
            log.error(
                "[L2PS] Error encrypting transaction " +
                    transaction.hash +
                    " on subnet " +
                    this.uid,
            )
            return encryptedTransactionResponse[1]
        }
        const encryptedTransaction: EncryptedTransaction =
            encryptedTransactionResponse[1]
        return encryptedTransaction
    }

    // REVIEW Implement a peer specific public key encryption method for e2e messages
    public async encryptTransactionForPeer(
        transaction: Transaction,
        peer: PeerL2PS,
    ): Promise<EncryptedTransaction> {
        if (!peer.L2PSpublicKeys.has(this.uid)) {
            log.warning(
                "[L2PS] Peer " +
                    peer.connection.string +
                    "(" +
                    peer.identity +
                    ")" +
                    " has no public key for subnet " +
                    this.uid,
            )
            return null
        }
        const publicKeyPEM = peer.L2PSpublicKeys.get(this.uid)
        const publicKey: forge.pki.rsa.PublicKey =
            forge.pki.publicKeyFromPem(publicKeyPEM)
        const jsonTransaction = JSON.stringify(transaction)
        // ! TODO Clean the typing of Cryptography.rsa.encrypt
        const encryptedBaseTxResponse = Cryptography.rsa.encrypt(
            jsonTransaction,
            publicKey,
        )
        if (!encryptedBaseTxResponse[0]) {
            log.error(
                "[L2PS] Error encrypting transaction for peer " +
                    peer.connection.string +
                    "(" +
                    peer.identity +
                    ")" +
                    " on subnet " +
                    this.uid,
            )
            return encryptedBaseTxResponse[1]
        }
        const encryptedBaseTx = encryptedBaseTxResponse[1]
        const encryptedTxHash = Hashing.sha256(JSON.stringify(encryptedBaseTx))
        let encryptedTransaction: EncryptedTransaction = {
            hash: transaction.hash,
            encryptedTransaction: encryptedBaseTx,
            encryptedHash: encryptedTxHash,
            blockNumber: transaction.blockNumber,
            L2PS: this.keypair.publicKey,
        }
        // REVIEW Double pass encryption with the subnet public key
        const encryptedTransactionDoublePassResponse = Cryptography.rsa.encrypt(
            JSON.stringify(encryptedTransaction),
            this.keypair.publicKey,
        )
        if (!encryptedTransactionDoublePassResponse[0]) {
            log.error(
                "[L2PS] Error encrypting transaction for peer " +
                    peer.connection.string +
                    "(" +
                    peer.identity +
                    ")" +
                    " on subnet " +
                    this.uid,
            )
            return encryptedTransactionDoublePassResponse[1]
        }
        encryptedTransaction = encryptedTransactionDoublePassResponse[1]
        return encryptedTransaction
    }
}
