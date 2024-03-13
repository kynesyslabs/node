import GLS from "../../gls/gls"
import { Operation, OperationResult } from "../executeOperations"

export async function assignXM(operation: Operation): Promise<OperationResult> {
    let { address, xm_hash } = operation.params
    return await GLS.addToGLSXM(address, xm_hash)
}
