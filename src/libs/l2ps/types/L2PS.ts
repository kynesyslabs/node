
import * as forge from "node-forge"
import * as forgeUtils from "src/libs/crypto/forgeUtils"
import Transaction from "src/libs/blockchain/transaction"
import Cryptography from "src/libs/crypto/cryptography"
import Hashing from "src/libs/crypto/hashing"
import { EncryptedTransaction } from "@kynesyslabs/demosdk/types"
import Chain from "src/libs/blockchain/chain"
import Block from "src/libs/blockchain/block"

export default class L2PS {
    encryptionKey: forge.pki.rsa.PublicKey
    uid: forge.pki.rsa.PublicKey
    decryptionKey: forge.pki.rsa.PrivateKey

    // Transactions that belong to the L2PS (hash -> transaction)
    encryptedTransactions: Map<string, EncryptedTransaction> = new Map()
    // TODO Add encryptedTransactions to the Block class and edit the db consequently


    constructor() {
        let rsaKeyPair = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 })
        this.encryptionKey = rsaKeyPair.publicKey
        this.uid = rsaKeyPair.publicKey
        this.decryptionKey = rsaKeyPair.privateKey
    }

    // SECTION Control methods

    // REVIEW See if it works based on the below // ?
    async getEncryptedTransactions(blockNumber: number): Promise<EncryptedTransaction[]> { // Map<string, EncryptedTransaction> {
        // TODO Fetch the encryptedTransactions from the database
        // this.encryptedTransactions = db.getEncryptedTransactions(blockNumber, this.uid)
        let retrievedBlock = await Chain.getBlockByNumber(blockNumber)
        let block: Block = new Block()
        block.content = retrievedBlock.content // ? Why do we have to do this
        let encryptedTransactions = block.content.encrypted_transactions
        return encryptedTransactions

    }

    // SECTION Encryption methods

    // Encrypt a transaction for partecipants
    private encryptTx(tx: Transaction): EncryptedTransaction {
        let eTx = this.encryptionKey.encrypt(JSON.stringify(tx))
        let eHash = Hashing.sha256(JSON.stringify(eTx))
        let blockNumber = tx.blockNumber
        let encryptedTx: EncryptedTransaction = {
            hash: tx.hash,
            encryptedHash: eHash,
            encryptedTransaction: eTx,
            blockNumber: blockNumber,
            L2PS: this.uid,
        }
        return encryptedTx
    }

    // Decrypt a transaction from L2PS
    private decryptTx(eTx: EncryptedTransaction): Transaction {
        let tx = this.decryptionKey.decrypt(eTx.encryptedTransaction)
        let dTx: Transaction = JSON.parse(tx)
        return dTx
    }

    // SECTION Retrieval methods

    // Retrieve a transaction from the L2PS
    getTx(eHash: string): Transaction {
        let eTx = this.encryptedTransactions.get(eHash)
        let tx = this.decryptTx(eTx)
        return tx
    }

    // SECTION Registration methods

    // Register a transaction in the L2PS
    registerTx(tx: Transaction): void {
        let eTx = this.encryptTx(tx)
        this.encryptedTransactions.set(eTx.encryptedHash, eTx)
    }

}