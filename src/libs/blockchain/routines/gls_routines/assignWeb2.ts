import GLS from "../../gls/gls"
import { Operation, OperationResult } from "../executeOperations"

export async function assignWeb2(
    operation: Operation,
): Promise<OperationResult> {
    let { address, web2_hash } = operation.params
    return await GLS.addToGLSWeb2(address, web2_hash)
}
