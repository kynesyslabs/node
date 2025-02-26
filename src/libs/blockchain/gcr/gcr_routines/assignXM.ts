import { Operation, OperationResult } from "@kynesyslabs/demosdk/types"

import GCR from "../gcr"

export async function assignXM(operation: Operation): Promise<OperationResult> {
    const { address, xmHash } = operation.params
    return await GCR.addToGCRXM(address, xmHash)
}
