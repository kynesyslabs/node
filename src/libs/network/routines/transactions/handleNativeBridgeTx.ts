import { bridge } from "@kynesyslabs/demosdk"
import { NativeBridgeTransaction } from "@kynesyslabs/demosdk/types"
import { NativeBridge } from "@kynesyslabs/demosdk/bridge"

/**
 * Handles the native bridge transaction (called by the endpoint handler)
 * @param operation The native bridge operation to handle
 *
 * @returns The hash of the transaction where the bridge operation is set to be executed
 */
export default async function handleNativeBridgeTx(
    tx: NativeBridgeTransaction,
): Promise<string> {
    // TODO Check if the compiled operation is valid
    const compiledOperation = tx.content
        .data[1] as bridge.NativeBridgeOperationCompiled
    // TODO Implement the handling of the native bridge transaction into the mempool

    const bridgeClient = new NativeBridge(null)
    await bridgeClient.validateOperation(compiledOperation.content.operation)
    // TODO: Do stuff here

    return tx.hash
}
