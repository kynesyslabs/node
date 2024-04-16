import GLS from "../../gls/gls"
import { Operation, OperationResult } from "@kynesyslabs/demosdk/types"

export async function assignWeb2(
    operation: Operation,
): Promise<OperationResult> {
    // @ts-expect-error
    let { address, web2_hash } = operation.params
    return await GLS.addToGLSWeb2(address, web2_hash)
}
