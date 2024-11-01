import { Operation, OperationResult } from "@kynesyslabs/demosdk/types"

import GCR from "../../gcr/gcr"
export async function assignWeb2(
    operation: Operation,
): Promise<OperationResult> {
    let { address, web2_hash } = operation.params
    return await GCR.addToGCRWeb2(address, web2_hash)
}
