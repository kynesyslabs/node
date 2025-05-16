import { NativeBridgeOperationCompiled } from "@kynesyslabs/demosdk/bridge"
import { Transaction } from "@kynesyslabs/demosdk/types"
/**
 * Handles the native bridge transaction (called by the endpoint handler)
 * @param operation The native bridge operation to handle
 * @returns The hash of the transaction where the bridge operation is set to be executed
 */
export default async function handleNativeBridgeTx(
    bridgeTx: Transaction,
): Promise<string> {
    // TODO Check if the compiled operation is valid
    const compiledOperation = bridgeTx.content
        .data[1] as NativeBridgeOperationCompiled
    // TODO Implement the handling of the native bridge transaction into the mempool
    return null
}
