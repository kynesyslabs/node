import { IWeb2Request } from "@kynesyslabs/demosdk/types"
import handleWeb2 from "src/features/web2/Web2Dispatcher"
import { RPCResponse } from "@kynesyslabs/demosdk/types"
import { emptyResponse } from "../../server_rpc"
import _ from "lodash"

// ? Can we avoid calling another function pls?

export default async function handleWeb2Request(
    content: IWeb2Request,
): Promise<RPCResponse> {
    /* NOTE This workflow goeas as:
     * The Web2 Operation is validated, executed and verified
     * when applicable. Is then sent back once attested.
     * A transaction is derived from the executed web2 operation.
     * An operation is then created and pushed in the GCR.
     * An operation for the gas is also pushed in the GCR.
     * The tx is pushed in the mempool if applicable.
     */
    console.log("[SERVER] Received web2Request")
    //console.log(JSON.stringify(request))
    let response = _.cloneDeep(emptyResponse)

    let extra: string,
        require_reply = false
    let webResponse: IWeb2Request
    // We get our connection string
    // const currentPeerString = Identity.getInstance().getConnectionString()
    // NOTE Switched to the new class

    //console.log("[WEB2 CONTENT DUMP]")
    //console.log(content)
    let fullResponse = await handleWeb2(content)
    //console.log("[WEB2 CONTENT RESPONSE DUMP]")
    //console.log(fullResponse)

    // Managing the results
    if (fullResponse[0]) {
        webResponse = fullResponse[1] as IWeb2Request
    } else {
        webResponse = null
        extra = fullResponse[1] as string
    }
    // Returning a proper response
    response.result = 200
    response.response = webResponse
    response.extra = extra
    return response
}
