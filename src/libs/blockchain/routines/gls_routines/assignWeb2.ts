import { Operation, OperationResult } from "@kynesyslabs/demosdk/types"

import GLS from "../../gls/gls"

export async function assignWeb2(
    operation: Operation,
): Promise<OperationResult> {
    let { address, web2_hash } = operation.params
    return await GLS.addToGLSWeb2(address, web2_hash)
}
