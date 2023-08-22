import { Operation, OperationResult } from "./executeOperations"

export default class subOperations {
    private static result: OperationResult = {
        success: true,
        message: "No error occurred",
    }
    constructor() {}

    // INFO Adding native tokens to the stated address
    static async addNative(operation: Operation): Promise<OperationResult>
    {
        // TODO
        return subOperations.result
    }

    // INFO Removing native tokens from the stated address
    static async removeNative(operation: Operation): Promise<OperationResult>
    {
        // TODO
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