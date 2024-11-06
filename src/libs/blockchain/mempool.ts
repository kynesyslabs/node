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
import Transaction from "./transaction"
import { ISignature } from "@kynesyslabs/demosdk/types"
import log from "src/utilities/logger"
import { getSharedState } from "src/utilities/sharedState"

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
    // INFO Reading the whole current mempool
    public static async getMempool(): Promise<MempoolData> {
        let timeout = 3000
        let waiting = false

        while (getSharedState.inGetMempool || getSharedState.inCleanMempool) {
            waiting = true
            if (timeout <= 0) {
                throw new Error(
                    "[MEMPOOL MANAGER] Timeout while waiting for the mempool",
                )
            }

            log.info("[MEMPOOL MANAGER] getMempool is locked, waiting...")
            timeout -= 250
            await new Promise(resolve => setTimeout(resolve, 250))
        }

        // If we were waiting, we can also see if the mempool has been cached
        if (waiting && getSharedState.mempoolCache) {
            log.info("[MEMPOOL MANAGER] Returning cached mempool")
            return getSharedState.mempoolCache
        }

        let mempool: MempoolData = null

        try {
            getSharedState.inGetMempool = true
            getSharedState.mempoolCache = null
            const db = await Datasource.getInstance()
            const mempoolRepository = db
                .getDataSource()
                .getRepository(MempoolEntity)

            let results = await mempoolRepository.findBy({ current: 1 })
            log.info("[MEMPOOL MANAGER] Mempool query result first try:")
            log.info("[MEMPOOL MANAGER] mempool: " + JSON.stringify(results))

            // In case there is no current mempool, lets create it
            if (!results || results.length === 0) {
                console.log(
                    "[Mempool] No current mempool found, creating one...",
                )
                let newMempool: SerializedMempoolData = {
                    number: 0,
                    current: 1,
                    transactions: JSON.stringify([]),
                    proposedBlock: null,
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

            console.log("[MEMPOOL MANAGER] Normalized mempool query result:")
            //console.log(firstResult)
            // Serializing
            mempool = {
                number: firstResult.number,
                current: firstResult.current,
                transactions: JSON.parse(firstResult.transactions),
                proposedBlock: JSON.parse(firstResult.proposedBlock),
                timestamp: new Date().getTime(),
            }
            log.info("[MEMPOOL MANAGER] Mempool retrieved:")
            log.info("[MEMPOOL MANAGER] mempool: " + JSON.stringify(mempool))

            getSharedState.mempoolCache = mempool
        } finally {
            getSharedState.inGetMempool = false
        }

        return mempool
    }

    // INFO Cleaning the mempool
    public static async clean(): Promise<void> {
        let timeout = 3000

        while (getSharedState.inGetMempool || getSharedState.inCleanMempool) {
            if (timeout <= 0) {
                throw new Error(
                    "[MEMPOOL MANAGER] Timeout while waiting to delete mempool",
                )
            }

            log.info(
                `[MEMPOOL MANAGER] inGetMempool: ${getSharedState.inGetMempool}, inCleanMempool: ${getSharedState.inCleanMempool}. Waiting...`,
                false,
            )

            timeout -= 250
            await new Promise(resolve => setTimeout(resolve, 250))
        }

        try {
            getSharedState.inCleanMempool = true

            log.info("[MEMPOOL MANAGER] Cleaning the mempool")

            const db = await Datasource.getInstance()
            const mempoolRepository = db
                .getDataSource()
                .getRepository(MempoolEntity)

            const mempool = await mempoolRepository.findBy({ current: 1 })
            log.info("[MEMPOOL MANAGER] Mempool to be deleted:")
            log.info(JSON.stringify(mempool))

            if (mempool.length > 0) {
                await mempoolRepository.delete({ current: 1 })
            }
        } finally {
            getSharedState.inCleanMempool = false
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
        let mempool = await this.getMempool()
        console.log(
            "adding transaction with hash " +
                transaction.hash +
                " to the mempool",
        )

        // FIXME Debug to remove
        let is_coherent = Transaction.isCoherent(transaction)
        if (!is_coherent) {
            console.error("Transaction in mempool is not coherent")
            process.exit(1)
        }

        //console.log(mempool)
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

    public static async removeTransaction(
        transaction: Transaction,
    ): Promise<void> {
        let mempool = await this.getMempool()

        let index = mempool.transactions.indexOf(transaction)
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
            let mempool = await this.getMempool() // Assuming getMempool is updated to work with TypeORM
            let next_number = mempool.number + 1

            // Archiving the current mempool
            await mempoolRepository.update(
                { current: 1 }, // Identify the current mempool
                { current: 0 }, // Set current to 0 to archive
            )

            // Creating a new mempool entity
            let newMempool = mempoolRepository.create({
                number: next_number,
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
        let peerlist = PeerManager.getInstance().getPeers()
        // TODO For cycle sending mempool to peerlist
    }

    // INFO Once receiving a mempool, we either merge or refuse it based on the following method ingesting it (first step)
    public static async receive(mempool: MempoolData): Promise<boolean> {
        // REVIEW and expand: parse, verify and call merge
        // Basic features that must be identical to us
        let local_mempool = await Mempool.getMempool()
        // We need to have the same forecasted block number, of course
        console.log("local mempool:")
        console.log(local_mempool)
        console.log("remote mempool:")
        console.log(mempool)
        if (local_mempool.number != mempool.number) {
            console.log("[MEMPOOL VERIFICATION] The block numbers do not match")
            return false
        }
        // Checking all the txs one by one for the signatures
        for (let i = 0; i < mempool.transactions.length; i++) {
            let tx = mempool.transactions[i]
            // NOTE Verifying the hash of the transaction
            let tx_hash = tx.hash
            console.log(
                "[MEMPOOL VERIFICATION] Verifying the hash of the transaction: " +
                    tx_hash,
            )
            console.log(JSON.stringify(tx.content))
            let calculated_hash = Hashing.sha256(JSON.stringify(tx.content))
            console.log(
                "[MEMPOOL VERIFICATION] Calculated hash: " + calculated_hash,
            )
            if (calculated_hash != tx_hash) {
                console.log(
                    "[X] [MEMPOOL VERIFICATION] The hash of the transaction is invalid",
                )
                return false
            }
            console.log(
                "[+] [MEMPOOL VERIFICATION] The hash of the transaction is valid",
            )
            // NOTE Verifying the signature against the verified hash using from as public key
            console.log("[MEMPOOL VERIFICATION] Verifying the signature")

            let signature = tx.signature // TODO Sometimes there is a nested type / data structure (see below)
            // REVIEW Ugly patch for the above TODO
            try {
                let signature_data = signature.data as unknown as ISignature
                if (!signature_data.data || !signature_data.type) {
                    throw new Error("[*] Signature fix failed successfully!")
                }
                console.log("[+] Signature fixed successfully!")
                signature = signature_data
            } catch (error) {
                console.log(
                    "[+] [MEMPOOL VERIFICATION] Signature did not need to be fixed",
                )
            }

            console.log(
                "[MEMPOOL VERIFICATION] Signature: " +
                    signature.data.toString("hex"),
            )
            let public_key = tx.content.from as any
            console.log(
                "[MEMPOOL VERIFICATION] Public key: " +
                    public_key.data.toString("hex"),
            )
            let signature_valid = Cryptography.verify(
                tx_hash,
                signature.data.toString("hex"),
                public_key,
            )
            if (!signature_valid) {
                console.log(
                    "[X] [MEMPOOL VERIFICATION] The signature is invalid",
                )
                return false
            }
        }
        console.log("[+] [MEMPOOL VERIFICATION] The signature is valid")
        // If everything is fine, we can merge the mempool
        console.log("[MEMPOOL MERGING] Merging the mempool")
        let success = await Mempool.merge(mempool)
        if (success) {
            console.log("[+] [MEMPOOL MERGING] The mempool has been merged")
        } else {
            console.log("[X] [MEMPOOL MERGING] The mempool has not been merged")
        }
        return success
    }

    // INFO Merging the mempool received (second step)
    public static async merge(received_mempool: MempoolData): Promise<boolean> {
        let mempool = await Mempool.getMempool()
        // REVIEW Checking and excluding duplicates
        for (let i = 0; i < received_mempool.transactions.length; i++) {
            let tx = received_mempool.transactions[i]
            let index = mempool.transactions.indexOf(tx)
            if (index != -1) {
                mempool.transactions.splice(index, 1)
            }
        }
        // Merge the mempool with our one
        mempool.transactions = mempool.transactions.concat(
            received_mempool.transactions,
        ) // REVIEW is this the best way to merge?
        const db = await Datasource.getInstance()
        const mempoolRepository = db
            .getDataSource()
            .getRepository(MempoolEntity)

        console.log("[MEMPOOL]: Updating transactions in mempool: ")
        console.log(JSON.stringify(mempool.transactions))

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
            let comparison =
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
        replace: boolean = true,
    ): Promise<MempoolData> {
        let local_mempool = await Mempool.getMempool()
        for (let i = 0; i < local_mempool.transactions.length; i++) {
            let pooled_tx = local_mempool.transactions[i]
            if (
                pooled_tx.content.from == tx.content.from &&
                pooled_tx.content.nonce == tx.content.nonce &&
                replace
            ) {
                local_mempool.transactions.splice(i, 1)

                const db = await Datasource.getInstance()
                const mempoolRepository = db
                    .getDataSource()
                    .getRepository(MempoolEntity)

                try {
                    await mempoolRepository.update(
                        { current: 1 }, // Assuming 'current' is a unique identifier for the mempool record
                        {
                            transactions: JSON.stringify(
                                local_mempool.transactions,
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

        return local_mempool
    }
}
