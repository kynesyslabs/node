import { TxFee } from "../types/transactions"

interface OperationResult {
    success: boolean;
    message: string;
}

export interface Operation {
    operator: string;
    actor: string;
    amount: number;
    hash: string;
    nonce: number;
    timestamp: number;
    status: boolean | "pending";
    fees: TxFee;
}

// NOTE The operator object is designed to represent a single operator and the status of its operations
export interface Operator {
	operations: Map<Operation, OperationResult>;
}

// ANCHOR Execute operations and merge GLS registry into the chain based on the status
export default async function executeOperations(operations: Operation[]): Promise<Map<string, Operator>> {
    let results = new Map<string, Operator>
    // First of all we divide the operations into groups of addresses
    let groups: Map <string, Operation[]> = new Map()
    let sorted_groups = groups
    groups = divideByAddress(operations)
    // Then for each group we sort it by fees
    for (let group of groups.values()) {
        let address = group[0].operator // Each group should have the same operator
        group = sortByNumeric(group, "fees")
        sorted_groups.set(address, group)
    }
    // For every group we execute the operations and set the results
    for (let group of sorted_groups.values()) {
        let address = group[0].operator
        let group_results = await executeSequence(group)
        results.set(address, group_results)
    }
    // Returns the complex result
    return results
}

// ANCHOR Non exported internal methods and mechanisms

// INFO Execute a sorted sequence of operations made by the same operator
async function executeSequence(operations: Operation[]): Promise<Operator> {
    let results: Operator
    // Execute the operations sequentially
    for (let i = 0; i < operations.length; i++) {
        let hash = operations[i].hash
        let error = "no error occurred"
        let valid = true // Until proven otherwise
        // TODO Implement nonce verification united to fee control to expose replacements
        // TODO How to handle all the txs together? In the results registry we will have to tinker a lot
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
        let address = operations[i].operator
        if (!divided.has(address)) {
            divided.set(address, [operations[i]])
        } else {
            divided.get(address).push(operations[i])
        }
    }
    return divided
}