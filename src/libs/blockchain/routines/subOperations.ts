import Datasource from "src/model/datasource"
import { Transactions } from "src/model/entities/Transactions"

import Block from "../block"
import Chain from "../chain"
import GLS from "../gls/gls"
import Genesis from "../types/genesisTypes"
import { Operation, OperationResult } from "@kynesyslabs/demosdk/types"
// NOTE Due to the modularity of the code, many routines will be stored in their own modules
// TODO Move everything there if possible
import glsRoutines from "./gls_routines"

// REVIEW Is this working?
export default class subOperations {
    public static glsRoutines = glsRoutines

    private static result: OperationResult = {
        success: true,
        message: "No error occurred",
    }
    constructor() {}

    // INFO Compiling the genesis status if not already done
    static async genesis(
        operation: Operation,
        genesis_block: Block,
    ): Promise<OperationResult> {
        let result: OperationResult = {
            success: true,
            message: "No error occurred",
        }
        // NOTE Insert blindly stuff into the GLS if no genesis is present
        // Using the genesis schema it is easy to follow the structure of the genesis file
        console.log(operation.params)
        let genesis_content: Genesis = operation.params
        // Let's extract the genesis transaction from the genesis block
        let genesis_tx = await Chain.getTransactionFromHash(
            genesis_block.content.ordered_transactions[0],
        )
        // NOTE Writing the tx to the chain tx table as it is the genesis one
        const db = await Datasource.getInstance()
        const transactionRepository = db
            .getDataSource()
            .getRepository(Transactions)

        // Assuming genesis_tx.content is an object that needs to be serialized as JSON
        const transaction = new Transactions()
        transaction.hash = genesis_tx.hash
        transaction.content = genesis_tx.content
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
        let balances = genesis_content.balances
        for (let i = 0; i < balances.length; i++) {
            let balance_operation = balances[i]
            let receiver = balance_operation[0]
            let amount = balance_operation[1]
            await GLS.setGLSNativeBalance(
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
        let from: string = operation.params.from
        let to: string = operation.params.to
        let amount = parseInt(operation.params.amount, 10)

        // Check if amount is a valid number
        if (isNaN(amount)) {
            return {
                success: false,
                message: "Invalid amount",
            }
        }
        let balance_from = await GLS.getGLSNativeBalance(from)
        let balance_to = await GLS.getGLSNativeBalance(to)
        // Sanity checks

        if (amount == 0) {
            return {
                success: false,
                message: "Amount cannot be 0",
            }
        } else if (amount > balance_from) {
            return {
                success: false,
                message: "Insufficient funds",
            }
        }
        // TODO
        // If we are here, we have a valid operation
        let new_balance_from = balance_from - amount
        let new_balance_to = balance_to + amount
        await GLS.setGLSNativeBalance(from, new_balance_from, operation.hash)
        await GLS.setGLSNativeBalance(to, new_balance_to, operation.hash)
        // Returning success
        return {
            success: true,
            message: "Transfer successful",
        }
    }

    // INFO Adding native tokens to the stated address
    static async addNative(operation: Operation): Promise<OperationResult> {
        let to: string = operation.params.to
        let amount: string = operation.params.amount
        let balance_to = await GLS.getGLSNativeBalance(to)
        // Sanity checks
        if (amount == "0") {
            return {
                success: false,
                message: "Amount cannot be 0",
            }
        }
        // TODO
        // If we are here, we have a valid operation
        let new_balance_to = balance_to + parseInt(amount)
        await GLS.setGLSNativeBalance(to, new_balance_to, operation.hash)
        return subOperations.result
    }

    // INFO Removing native tokens from the stated address
    static async removeNative(operation: Operation): Promise<OperationResult> {
        let to: string = operation.params.to
        let amount: string = operation.params.amount
        let balance_to = await GLS.getGLSNativeBalance(to)
        // Sanity checks
        if (amount == "0") {
            return {
                success: false,
                message: "Amount cannot be 0",
            }
        } else if (balance_to < parseInt(amount)) {
            return {
                success: false,
                message: "Insufficient funds",
            }
        }
        // TODO
        // If we are here, we have a valid operation
        let new_balance_to = balance_to - parseInt(amount)
        await GLS.setGLSNativeBalance(to, new_balance_to, operation.hash)
        return subOperations.result
    }

    static async addAsset(operation: Operation): Promise<OperationResult> {
        // TODO
        return subOperations.result
    }

    static async removeAsset(operation: Operation): Promise<OperationResult> {
        // TODO
        return subOperations.result
    }
}
