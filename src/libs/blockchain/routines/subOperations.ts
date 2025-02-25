import Datasource from "src/model/datasource"
import { Transactions } from "src/model/entities/Transactions"

import { Operation, OperationResult } from "@kynesyslabs/demosdk/types"

import Block from "../block"
import Chain from "../chain"
import GCR from "../gcr/gcr"
import Genesis from "../types/genesisTypes"
// NOTE Due to the modularity of the code, many routines will be stored in their own modules
// TODO Move everything there if possible
import gcrRoutines from "../gcr/gcr_routines"

// REVIEW Is this working?
export default class SubOperations {
    public static gcrRoutines = gcrRoutines

    private static result: OperationResult = {
        success: true,
        message: "No error occurred",
    }
    constructor() {}

    // INFO Compiling the genesis status if not already done
    static async genesis(
        operation: Operation,
        genesisBlock: Block,
    ): Promise<OperationResult> {
        const result: OperationResult = {
            success: true,
            message: "No error occurred",
        }
        // NOTE Insert blindly stuff into the GCR if no genesis is present
        // Using the genesis schema it is easy to follow the structure of the genesis file
        console.log(operation.params)
        const genesisContent: Genesis = operation.params
        // Let's extract the genesis transaction from the genesis block
        const genesisTx = await Chain.getTransactionFromHash(
            genesisBlock.content.ordered_transactions[0],
        )
        // NOTE Writing the tx to the chain tx table as it is the genesis one
        const db = await Datasource.getInstance()
        const transactionRepository = db
            .getDataSource()
            .getRepository(Transactions)

        // Assuming genesis_tx.content is an object that needs to be serialized as JSON
        const transaction = new Transactions()
        transaction.hash = genesisTx.hash
        transaction.content = genesisTx.content
        transaction.signature = "genesis"
        transaction.status = "someStatus"
        transaction.type = "genesis"
        transaction.blockNumber = 0
        transaction.amount = 0 // TODO: Maybe store the amount as defined in balances below here?
        transaction.nonce = 0
        transaction.timestamp = Date.now()

        // Save the new transaction
        await transactionRepository.save(transaction)

        // NOTE Balances
        const balances = genesisContent.balances
        for (let i = 0; i < balances.length; i++) {
            const balanceOperation = balances[i]
            const receiver = balanceOperation[0]
            const amount = balanceOperation[1]
            await GCR.setGCRNativeBalance(
                receiver,
                parseInt(amount),
                operation.hash,
            )
        }
        return result
    }

    // INFO Remove & Add transfer operation for native balances
    static async transferNative(
        operation: Operation,
    ): Promise<OperationResult> {
        const from: string = operation.params.from
        const to: string = operation.params.to
        const amount = parseInt(operation.params.amount, 10)

        // Check if amount is a valid number
        if (isNaN(amount)) {
            return {
                success: false,
                message: "Invalid amount",
            }
        }
        const balanceFrom = await GCR.getGCRNativeBalance(from)
        const balanceTo = await GCR.getGCRNativeBalance(to)
        // Sanity checks

        if (amount == 0) {
            return {
                success: false,
                message: "Amount cannot be 0",
            }
        } else if (amount > balanceFrom) {
            return {
                success: false,
                message: "Insufficient funds",
            }
        }
        // TODO
        // If we are here, we have a valid operation
        const newBalanceFrom = balanceFrom - amount
        const newBalanceTo = balanceTo + amount
        await GCR.setGCRNativeBalance(from, newBalanceFrom, operation.hash)
        await GCR.setGCRNativeBalance(to, newBalanceTo, operation.hash)
        // Returning success
        return {
            success: true,
            message: "Transfer successful",
        }
    }

    // INFO Adding native tokens to the stated address
    static async addNative(operation: Operation): Promise<OperationResult> {
        const to: string = operation.params.to
        const amount: string = operation.params.amount
        const balanceTo = await GCR.getGCRNativeBalance(to)
        // Sanity checks
        if (amount == "0") {
            return {
                success: false,
                message: "Amount cannot be 0",
            }
        }
        // TODO
        // If we are here, we have a valid operation
        const newBalanceTo = balanceTo + parseInt(amount)
        await GCR.setGCRNativeBalance(to, newBalanceTo, operation.hash)
        return SubOperations.result
    }

    // INFO Removing native tokens from the stated address
    static async removeNative(operation: Operation): Promise<OperationResult> {
        const to: string = operation.params.to
        const amount: string = operation.params.amount
        const balanceTo = await GCR.getGCRNativeBalance(to)
        // Sanity checks
        if (amount == "0") {
            return {
                success: false,
                message: "Amount cannot be 0",
            }
        } else if (balanceTo < parseInt(amount)) {
            return {
                success: false,
                message: "Insufficient funds",
            }
        }
        // TODO
        // If we are here, we have a valid operation
        const newBalanceTo = balanceTo - parseInt(amount)
        await GCR.setGCRNativeBalance(to, newBalanceTo, operation.hash)
        return SubOperations.result
    }

    static async addAsset(operation: Operation): Promise<OperationResult> {
        // TODO
        return SubOperations.result
    }

    static async removeAsset(operation: Operation): Promise<OperationResult> {
        // TODO
        return SubOperations.result
    }
}
