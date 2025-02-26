import { Operation, OperationResult } from "@kynesyslabs/demosdk/types"

import GCR from "../gcr"
export async function assignWeb2(
    operation: Operation,
): Promise<OperationResult> {
    const { address, web2Hash } = operation.params
    return await GCR.addToGCRWeb2(address, web2Hash)
}
