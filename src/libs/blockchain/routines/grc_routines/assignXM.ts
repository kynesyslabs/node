import { Operation, OperationResult } from "@kynesyslabs/demosdk/types"

import GCR from "../../gcr/gcr"

export async function assignXM(operation: Operation): Promise<OperationResult> {
    let { address, xm_hash } = operation.params
    return await GCR.addToGCRXM(address, xm_hash)
}
