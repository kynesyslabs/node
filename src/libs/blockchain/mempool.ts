/* eslint-disable no-unused-vars */
/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

// TODO Test the db instance of mempool and check if all the tables are ok

import Datasource from "src/model/datasource"
import { Mempool as MempoolEntity } from "src/model/entities/Mempool"

import Cryptography from "../crypto/cryptography"
import Hashing from "../crypto/hashing"
import PeerManager from "../peer/PeerManager"
import Block from "./block"
// INFO Singleton Mempool class
import { ISignature } from "@kynesyslabs/demosdk/types"
import log from "src/utilities/logger"
import { getSharedState } from "src/utilities/sharedState"
import Transaction from "./transaction"
import { forgeToHex } from "../crypto/forgeUtils"

// Bun does not support NodeJS.Timeout, so we need to create a type for it
type TimeoutType = ReturnType<typeof setTimeout>
/** Another possible solution
type TimeoutType = typeof globalThis extends { setTimeout: any }
    ? ReturnType<typeof setTimeout>
    : any
*/

class MempoolLock {
    locked: boolean
    waitQueue: {
        resolve: (from: string) => void
        reject: (reason?: any) => void
        // WARNING Bun does not support NodeJS.Timeout, so we need to use the TimeoutType
        // ! On errors, we can just cast NodeJS.Timeout here
        timeoutId: TimeoutType
        from: string
    }[]
    timeout: number

    constructor(timeout = 30000) {
        this.locked = false
        this.waitQueue = []
        this.timeout = timeout
    }

    async acquire(from: string) {
        // If not locked, acquire immediately
        if (!this.locked) {
            this.locked = true
            log.info(`[MEMPOOL LOCK] Acquired lock from ${from}`)
            return true
        }

        // Create a promise that will be resolved when it's this caller's turn
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                // Remove from queue if timeout occurs
                const index = this.waitQueue.findIndex(
                    waiter => waiter.from === from,
                )
                if (index !== -1) {
                    this.waitQueue.splice(index, 1)
                }
                reject(
                    new Error(
                        `[MEMPOOL LOCK] acquisition timeout from ${from}`,
                    ),
                )
            }, this.timeout)

            // Add to queue
            this.waitQueue.push({
                resolve,
                reject,
                // WARNING Bun does not support NodeJS.Timeout, so we need to cast it
                // ! If we use Bun, we need to change this
                timeoutId: timeoutId as TimeoutType,
                from,
            })
        })
    }

    release(from: string) {
        if (!this.locked) {
            return
        }

        // Get next waiter from queue
        const nextWaiter = this.waitQueue.shift()

        if (nextWaiter) {
            clearTimeout(nextWaiter.timeoutId)
            nextWaiter.resolve(from)
        } else {
            this.locked = false
            log.info(`[MEMPOOL LOCK] Released lock from ${from}`)
        }
        // Note: lock remains true as it's being passed to next waiter
    }
}

export interface MempoolData {
    number: number
    current: number
    transactions: Transaction[]
    proposedBlock: Block
    timestamp: number
}

export interface SerializedMempoolData {
    number: number
    current: number
    transactions: string
    proposedBlock: string
    timestamp: number
}

export default class Mempool {
    private static lock: MempoolLock = new MempoolLock()

    // INFO Reading the whole current mempool
    public static async getMempool(from = ""): Promise<MempoolData> {
        from += `_${Math.floor(Math.random() * 1000)}`
        log.info(`[MEMPOOL MANAGER] Entering getMempool from ${from}`)
        const waiting = this.lock.locked

        try {
            await this.lock.acquire(from)

            // If we were waiting, we can also see if the mempool has been cached
            if (waiting && getSharedState.mempoolCache) {
                log.info("[MEMPOOL MANAGER] Returning cached mempool")
                return getSharedState.mempoolCache
            }

            getSharedState.mempoolCache = null
            log.info(
                "[MEMPOOL MANAGER] Connecting to the database from " + from,
            )
            const db = await Datasource.getInstance()
            log.info("[MEMPOOL MANAGER] Database connected from " + from)

            const mempoolRepository = db
                .getDataSource()
                .getRepository(MempoolEntity)

            log.info("[MEMPOOL MANAGER] Querying the database from " + from)
            let results = await mempoolRepository.findBy({ current: 1 })
            log.info("[MEMPOOL MANAGER] Mempool query result first try:")
            log.info("[MEMPOOL MANAGER] mempool: " + JSON.stringify(results))

            // In case there is no current mempool, lets create it
            if (!results || results.length === 0) {
                log.info("[Mempool] No current mempool found, creating one...")
                const newMempool: SerializedMempoolData = {
                    number: 0,
                    current: 1,
                    transactions: JSON.stringify([]),
                    proposedBlock: JSON.stringify({}),
                    timestamp: new Date().getTime(),
                }
                const db = await Datasource.getInstance()
                const mempoolRepository = db
                    .getDataSource()
                    .getRepository(MempoolEntity)

                const result = await mempoolRepository.save(newMempool)
                log.info("[MEMPOOL MANAGER] New mempool created:")
                log.info(
                    "[MEMPOOL MANAGER] Awaited mempool data: " +
                        JSON.stringify(result),
                )
                results = await mempoolRepository.findBy({ current: 1 })
            }
            log.info("[MEMPOOL MANAGER] Mempool query result second try:")
            log.info("mempool: " + JSON.stringify(results))

            const firstResult = results[0]

            // Else we take the object itself

            log.info("[MEMPOOL MANAGER] Normalized mempool query result:")
            //log.info(firstResult)
            // Serializing
            const mempool: MempoolData = {
                number: firstResult.number,
                current: firstResult.current,
                transactions: JSON.parse(firstResult.transactions),
                proposedBlock: JSON.parse(firstResult.proposedBlock),
                timestamp: new Date().getTime(),
            }
            log.info("[MEMPOOL MANAGER] Mempool retrieved:")
            log.info("[MEMPOOL MANAGER] mempool: " + JSON.stringify(mempool))

            getSharedState.mempoolCache = mempool
            return mempool
        } catch (error) {
            log.error(
                `[MEMPOOL MANAGER] Error retrieving mempool from ${from}:`,
            )
            log.error(error as string)
        } finally {
            log.info(`[MEMPOOL MANAGER] Exiting getMempool from ${from}`)
            this.lock.release(from)
        }
    }

    // INFO Cleaning the mempool
    public static async clean(): Promise<void> {
        try {
            await this.lock.acquire("Mempool.clean")

            log.info("[MEMPOOL MANAGER] Cleaning the mempool")

            const db = await Datasource.getInstance()
            const mempoolRepository = db
                .getDataSource()
                .getRepository(MempoolEntity)

            const mempool = await mempoolRepository.findBy({ current: 1 })

            if (mempool.length > 0) {
                await mempoolRepository.delete({ current: 1 })
            }
        } finally {
            this.lock.release("Mempool.clean")
        }
    }

    // INFO Writing a transaction to the mempool
    /* NOTE
        Here we should already have cryptographically valid data: adding the transaction to the mempool is the way
        to flag it for verification and execution at consensus.
    */
    public static async addTransaction(
        transaction: Transaction,
    ): Promise<void> {
        const mempool = await this.getMempool("Mempool.addTransaction")
        log.info(
            "adding transaction with hash " +
                transaction.hash +
                " to the mempool",
        )

        // ! Debug to remove
        const isCoherent = Transaction.isCoherent(transaction)
        if (!isCoherent) {
            console.error("Transaction in mempool is not coherent")
            process.exit(1)
        }

        //log.info(mempool)
        mempool.transactions.push(transaction) // REVIEW What if it is empty?

        const db = await Datasource.getInstance()
        const mempoolRepository = db
            .getDataSource()
            .getRepository(MempoolEntity)

        const serializedMempool: SerializedMempoolData = {
            number: mempool.number,
            current: mempool.current,
            transactions: JSON.stringify(mempool.transactions),
            proposedBlock: JSON.stringify(mempool.proposedBlock),
            timestamp: mempool.timestamp,
        }

        await mempoolRepository.update({ current: 1 }, serializedMempool)
    }

    public static async removeTransactionsWithHashes(
        hashes: string[],
    ): Promise<void> {
        let mempool = await this.getMempool(
            "Mempool.removeTransactionsWithHashes",
        )

        const hashSet = new Set(hashes)
        mempool.transactions = mempool.transactions.filter(
            tx => !hashSet.has(tx.hash),
        )

        const db = await Datasource.getInstance()
        const mempoolRepository = db
            .getDataSource()
            .getRepository(MempoolEntity)

        try {
            await mempoolRepository.update(
                { current: 1 },
                { transactions: JSON.stringify(mempool.transactions) },
            )
        } catch (error) {
            log.error(
                "[MEMPOOL MANAGER] Error removing transactions from mempool:" +
                    error.toString(),
            )
        }
    }

    public static async removeTransaction(
        transaction: Transaction,
    ): Promise<void> {
        const mempool = await this.getMempool("Mempool.removeTransaction")

        const index = mempool.transactions.indexOf(transaction)
        if (index > -1) {
            mempool.transactions.splice(index, 1)

            const db = await Datasource.getInstance()
            const mempoolRepository = db
                .getDataSource()
                .getRepository(MempoolEntity)

            try {
                await mempoolRepository.update(
                    { current: 1 },
                    { transactions: JSON.stringify(mempool.transactions) },
                )
            } catch (error) {
                console.error("Error removing transaction from mempool:", error)
            }
        } else {
            console.warn("Transaction not found in mempool.")
        }
    }

    public static async nextMempool(): Promise<void> {
        const db = await Datasource.getInstance()
        const mempoolRepository = db
            .getDataSource()
            .getRepository(MempoolEntity)

        try {
            // Getting the current mempool
            const mempool = await this.getMempool("Mempool.nextMempool") // Assuming getMempool is updated to work with TypeORM
            const nextNumber = mempool.number + 1

            // Archiving the current mempool
            await mempoolRepository.update(
                { current: 1 }, // Identify the current mempool
                { current: 0 }, // Set current to 0 to archive
            )

            // Creating a new mempool entity
            const newMempool = mempoolRepository.create({
                number: nextNumber,
                current: 1,
                transactions: JSON.stringify([]),
                proposedBlock: JSON.stringify({}),
                timestamp: new Date().getTime(),
            })

            await mempoolRepository.save(newMempool)
        } catch (error) {
            console.error("Error in nextMempool:", error)
            // Handle the error appropriately
        }
    }

    /* TODO Representative Shard

    Deterministic group selection
    - The group sync the mempool and exclude the invalid transactions
    - mempool sort by gas fee bid (see gas fee in yp) -> market of nodes buziness
    - BFT
    */
    // INFO Broadcasting the mempool to all the peers
    public static async broadcast() {
        // Retrieve peerlist
        const peerlist = PeerManager.getInstance().getPeers()
        // TODO For cycle sending mempool to peerlist
    }

    // INFO Once receiving a mempool, we either merge or refuse it based on the following method ingesting it (first step)
    public static async receive(mempool: MempoolData): Promise<boolean> {
        // REVIEW and expand: parse, verify and call merge
        // Basic features that must be identical to us
        const localMempool = await Mempool.getMempool("Mempool.receive")
        // We need to have the same forecasted block number, of course
        log.info("local mempool:")
        log.info(JSON.stringify(localMempool))
        log.info("remote mempool:")
        log.info(JSON.stringify(mempool))
        if (localMempool.number != mempool.number) {
            log.info("[MEMPOOL VERIFICATION] The block numbers do not match")
            return false
        }

        // Checking all the txs one by one for the signatures
        for (let i = 0; i < mempool.transactions.length; i++) {
            const tx = mempool.transactions[i]
            // NOTE Verifying the hash of the transaction
            const txHash = tx.hash
            log.info(
                "[MEMPOOL VERIFICATION] Verifying the hash of the transaction: " +
                    txHash,
            )
            log.info(JSON.stringify(tx.content))
            const calculatedHash = Hashing.sha256(JSON.stringify(tx.content))
            log.info(
                "[MEMPOOL VERIFICATION] Calculated hash: " + calculatedHash,
            )

            if (calculatedHash != txHash) {
                log.info(
                    "[X] [MEMPOOL VERIFICATION] The hash of the transaction is invalid",
                )
                return false
            }

            log.info(
                "[+] [MEMPOOL VERIFICATION] The hash of the transaction is valid",
            )
            // NOTE Verifying the signature against the verified hash using from as public key
            log.info("[MEMPOOL VERIFICATION] Verifying the signature")

            let signature = tx.signature // TODO Sometimes there is a nested type / data structure (see below)
            // REVIEW Ugly patch for the above TODO
            try {
                const signatureData = signature.data as unknown as ISignature
                if (!signatureData.data || !signatureData.type) {
                    throw new Error("[*] Signature fix failed successfully!")
                }
                log.info("[+] Signature fixed successfully!")
                signature = signatureData
            } catch (error) {
                log.info(
                    "[+] [MEMPOOL VERIFICATION] Signature did not need to be fixed",
                )
            }

            log.info(
                "[MEMPOOL VERIFICATION] Signature: " +
                    signature.data.toString("hex"),
            )
            const publicKey = tx.content.from as any
            log.info(
                "[MEMPOOL VERIFICATION] Public key: " +
                    publicKey.data.toString("hex"),
            )
            console.log("[DEBUG] tx_hash: (" + typeof txHash + ")")
            console.log(txHash)
            console.log(
                "[DEBUG] signature.data: (" + typeof signature.data + ")",
            )
            console.log(signature.data.toString("hex"))
            console.log("[DEBUG] public_key: (" + typeof publicKey + ")")
            console.log(publicKey)
            const signatureValid = Cryptography.verify(
                txHash,
                forgeToHex(signature.data),
                forgeToHex(publicKey),
            )
            if (!signatureValid) {
                log.info("[X] [MEMPOOL VERIFICATION] The signature is invalid")
                return false
            }
        }
        log.info("[+] [MEMPOOL VERIFICATION] The signature is valid")
        // If everything is fine, we can merge the mempool
        log.info("[MEMPOOL MERGING] Merging the mempool")
        const success = await Mempool.merge(mempool)
        if (success) {
            log.info("[+] [MEMPOOL MERGING] The mempool has been merged")
        } else {
            log.info("[X] [MEMPOOL MERGING] The mempool has not been merged")
        }
        return success
    }

    // INFO Merging the mempool received (second step)
    public static async merge(receivedMempool: MempoolData): Promise<boolean> {
        const mempool = await Mempool.getMempool("Mempool.merge")
        const existingTxs = new Map<string, boolean>()

        for (let i = 0; i < mempool.transactions.length; i++) {
            const tx = mempool.transactions[i]
            existingTxs.set(tx.hash, true)
        }

        // REVIEW Checking and excluding duplicates
        for (let i = 0; i < receivedMempool.transactions.length; i++) {
            const tx = receivedMempool.transactions[i]

            if (existingTxs.has(tx.hash)) {
                log.debug(
                    "[MEMPOOL MERGING] Transaction already in mempool: " +
                        tx.hash,
                )
                mempool.transactions.splice(i, 1)
            }
        }

        // Merge the mempool with our one
        mempool.transactions = mempool.transactions.concat(
            receivedMempool.transactions,
        ) // REVIEW is this the best way to merge?
        const db = await Datasource.getInstance()
        const mempoolRepository = db
            .getDataSource()
            .getRepository(MempoolEntity)

        log.info("[MEMPOOL]: Updating transactions in mempool: ")
        log.info(JSON.stringify(mempool.transactions))

        try {
            await mempoolRepository.update(
                { current: 1 }, // Assuming 'current' is a unique identifier for the mempool record
                { transactions: JSON.stringify(mempool.transactions) },
            )
        } catch (error) {
            console.error("Error removing transaction from mempool:", error)
            // Handle the error appropriately
        }
        return true
    }

    // INFO Sorting the mempool in place (final step)
    public static async sort(mempool: MempoolData): Promise<MempoolData> {
        mempool.transactions.sort((tx1, tx2) => {
            const comparison =
                tx1.content.transaction_fee.rpc_fee >
                tx2.content.transaction_fee.rpc_fee
                    ? -1
                    : tx1.content.transaction_fee.rpc_fee <
                      tx2.content.transaction_fee.rpc_fee
                    ? 1
                    : 0
            if (comparison) {
                return -1
            } else {
                return 1
            }
        })
        const db = await Datasource.getInstance()
        const mempoolRepository = db
            .getDataSource()
            .getRepository(MempoolEntity)

        try {
            await mempoolRepository.update(
                { current: 1 }, // Assuming 'current' is a unique identifier for the mempool record
                { transactions: JSON.stringify(mempool.transactions) },
            )
        } catch (error) {
            console.error("Error removing transaction from mempool:", error)
            // Handle the error appropriately
        }
        return mempool
    }

    // INFO Checking for double nonces for same address
    public static async checkNonce(
        tx: Transaction,
        replace = true,
    ): Promise<MempoolData> {
        const localMempool = await Mempool.getMempool("Mempool.checkNonce")
        for (let i = 0; i < localMempool.transactions.length; i++) {
            const pooledTx = localMempool.transactions[i]
            if (
                pooledTx.content.from == tx.content.from &&
                pooledTx.content.nonce == tx.content.nonce &&
                replace
            ) {
                localMempool.transactions.splice(i, 1)

                const db = await Datasource.getInstance()
                const mempoolRepository = db
                    .getDataSource()
                    .getRepository(MempoolEntity)

                try {
                    await mempoolRepository.update(
                        { current: 1 }, // Assuming 'current' is a unique identifier for the mempool record
                        {
                            transactions: JSON.stringify(
                                localMempool.transactions,
                            ),
                        },
                    )
                } catch (error) {
                    console.error(
                        "Error removing transaction from mempool:",
                        error,
                    )
                    // Handle the error appropriately
                }
            }
        }

        return localMempool
    }
}
