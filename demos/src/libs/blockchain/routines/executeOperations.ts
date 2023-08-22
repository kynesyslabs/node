/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/


/* NOTE
    executeOperations is called AFTER the transaction validated by the consensus (or immediately if
	it is the genesis transaction) and is responsible for reflecting the changes in the database.

	executeSequence is called for each address to execute the operations contained.
*/

import { TxFee } from "../types/transactions"
import subOperations from "./subOperations"

export interface OperationResult {
    success: boolean;
    message: string;
}

export interface Operation { // TODO Add parameters as a property
    operator: string;
    actor: string;
    params: any;
    hash: string;
    nonce: number;
    timestamp: number;
    status: boolean | "pending";
    fees: TxFee;
}

// NOTE The Actor object is designed to represent a single operator and the status of its operations
export interface Actor {
	operations: Map<Operation, OperationResult>;
}

// ANCHOR Execute operations and merge GLS registry into the chain based on the status
export default async function executeOperations(operations: Operation[]): Promise<Map<string, Actor>> {
    let results = new Map<string, Actor>
    // First of all we divide the operations into groups of addresses
    let groups: Map <string, Operation[]> = new Map()
    let sorted_groups = groups
    groups = divideByAddress(operations)
    // Then for each group we sort it by fees
    for (let group of groups.values()) {
        let address = group[0].actor // Each group should have the same actor
        group = sortByNumeric(group, "fees")
        sorted_groups.set(address, group)
    }
    // For every group we execute the operations and set the results
    for (let group of sorted_groups.values()) {
        let address = group[0].actor
        let group_results = await executeSequence(group)
        results.set(address, group_results)
    }
    // Returns the complex result
    return results
}

// ANCHOR Non exported internal methods and mechanisms

// INFO Execute a sorted sequence of operations made by the same operator
async function executeSequence(operations: Operation[]): Promise<Actor> {
    let results: Actor
    // Execute the operations sequentially
    for (let i = 0; i < operations.length; i++) {
        let hash = operations[i].hash
        let error = "no error occurred"
        let valid = true // Until proven otherwise
        let result: OperationResult = {
            success: true,
            message: error,
        }
        // TODO Implement nonce verification united to fee control to expose replacements
        // TODO How to handle all the txs together? In the results registry we will have to tinker a lot
        // Dispatching the operation to the appropriate method
        switch (operations[i].operator) {
            case "genesis":
                result = await subOperations.genesis(operations[i])
                break
            case "transfer_native":
                result = await subOperations.transferNative(operations[i])
                break
            case "add_native":
                result = await subOperations.addNative(operations[i])
                results.operations.set(operations[i], result)
                break
            case "remove_native":
                result = await subOperations.removeNative(operations[i])
                results.operations.set(operations[i], result)
                break
            case "add_asset":
                result = await subOperations.addAsset(operations[i])
                results.operations.set(operations[i], result)
                break
            case "remove_asset":
                result = await subOperations.removeAsset(operations[i])
                results.operations.set(operations[i], result)
                break
            default:
                valid = false
                error = "unknown operator"
                break
        }
        operations[i].status = valid
        results.operations.set(operations[i], {
            success: valid,
            message: valid? "Transaction executed" : "Transaction failed due to: " + error,
        })
    }
    // Returns the success and message for each operation
    return results
}

// INFO Given a list of operations and a property name, sort the list by that property value
function sortByNumeric(list: Operation[], key: string, ascending=true): Operation[] {
    let sorted: Operation[]
    for (let i = 0; i < list.length; i++) {
        let operation = list[i]
        // Creating the first element if is not present yet
        if (sorted.length === 0) {
            sorted = [operation]
            continue
        }
        // Sorting the list by the given key one by one
        for (let j = 0; j < sorted.length; j++) {
            if (sorted[j][key] < operation[key]) {
                sorted.splice(j, 0, operation)
                break
            } else if (sorted[j][key] > operation[key]) {
                sorted.splice(j + 1, 0, operation)
                break
            }
        }
    }
    return sorted
}

// INFO Given a list of operations, divide them in a map of addresses to their corresponding operations
function divideByAddress(operations: Operation[]): Map <string, Operation[]> {
    let divided: Map <string, Operation[]> = new Map()
    for (let i = 0; i < operations.length; i++) {
        let address = operations[i].actor
        if (!divided.has(address)) {
            divided.set(address, [operations[i]])
        } else {
            divided.get(address).push(operations[i])
        }
    }
    return divided
}