import { Operation, OperationResult } from "@kynesyslabs/demosdk/types"

import GLS from "../../gls/gls"

export async function assignXM(operation: Operation): Promise<OperationResult> {
    let { address, xm_hash } = operation.params
    return await GLS.addToGLSXM(address, xm_hash)
}
