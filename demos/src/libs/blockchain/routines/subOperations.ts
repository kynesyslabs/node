import { Operation, OperationResult } from "./executeOperations"
import GLS from "../gls/gls"
import Genesis from "../types/genesisTypes"
import Chain from "../chain"
import Block from "../blocks"

// REVIEW Is this working?
export default class subOperations {
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
        let genesis_tx = genesis_block.content.ordered_transactions[0]
        // NOTE Writing the tx to the chain tx table as it is the genesis one
        await Chain.write(
            "INSERT INTO transactions (hash, content, signature, confirmations, state_changes) VALUES ( \
			'" +
                genesis_tx.hash +
                "', \
			'" +
                JSON.stringify(genesis_tx.content) +
                "', \
			'genesis', '0', '[]')",
        )
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

    // INFO Remove & Add transfer operation
    static async transferNative(
        operation: Operation,
    ): Promise<OperationResult> {
        let from: string = operation.params.from
        let to: string = operation.params.to
        let amount: string = operation.params.amount
        let balance_from = await GLS.getGLSNativeBalance(from)
        let balance_to = await GLS.getGLSNativeBalance(to)
        // Sanity checks
        if (amount == "0") {
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
        let new_balance_from = balance_from - parseInt(amount)
        let new_balance_to = balance_to + parseInt(amount)
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
