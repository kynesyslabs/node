import GLS from "../../gls/gls"
import { Operation, OperationResult } from "@kynesyslabs/demosdk/types"

export async function assignXM(operation: Operation): Promise<OperationResult> {
    // @ts-expect-error
    let { address, xm_hash } = operation.params
    return await GLS.addToGLSXM(address, xm_hash)
}
