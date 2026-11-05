import { bridge } from "@kynesyslabs/demosdk"
import { RPCResponse } from "@kynesyslabs/demosdk/types"

/**
 * Compiling and signing native bridge operations is not implemented. The
 * call used to answer 200 with an operation carrying an empty signature,
 * which a client could take for a node-approved one, so it answers 501
 * until signing exists.
 */
export async function manageNativeBridge(
    _operation: bridge.NativeBridgeOperation,
): Promise<RPCResponse> {
    return {
        result: 501,
        response: "Native bridge operations are not implemented on this node",
        require_reply: false,
        extra: null,
    }
}
