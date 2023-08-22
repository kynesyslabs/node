import { Operation, OperationResult } from "./executeOperations"
import GLS from "../gls/gls"

// REVIEW Is this working?
export default class subOperations {
    private static result: OperationResult = {
        success: true,
        message: "No error occurred",
    }
    constructor() {}

    // INFO Remove & Add transfer operation
    static async transferNative(operation: Operation): Promise<OperationResult> {
        let from: string = operation.params.from
        let to: string    = operation.params.to
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
    static async addNative(operation: Operation): Promise<OperationResult>
    {
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
    static async removeNative(operation: Operation): Promise<OperationResult>
    {
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

    static async addAsset(operation: Operation): Promise<OperationResult>
    {
        // TODO
        return subOperations.result
    }

    static async removeAsset(operation: Operation): Promise<OperationResult>
    {
        // TODO
        return subOperations.result
    }

}