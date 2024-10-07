import {
    IWeb2Attestation,
    IWeb2Request,
    RPCResponse,
} from "@kynesyslabs/demosdk/types"
import { handleWeb2 } from "src/features/web2/handleWeb2"
import { emptyResponse } from "../../server_rpc"
import _ from "lodash"
import { DAHR } from "src/features/web2/dahr/DAHR"
import { EnumWeb2Methods } from "src/features/web2/dahr/Proxy"

// ? Can we avoid calling another function pls?

export default async function handleWeb2Request(
    content: IWeb2Request,
): Promise<RPCResponse> {
    /* NOTE This workflow goes as:
     * The Web2 Operation is validated, executed and verified
     * when applicable. Is then sent back once attested.
     * A transaction is derived from the executed web2 operation.
     * An operation is then created and pushed in the GLS.
     * An operation for the gas is also pushed in the GLS.
     * The tx is pushed in the mempool if applicable.
     */
    console.log("[SERVER] Received web2Request")

    const response = _.cloneDeep(emptyResponse),
        fullResponse = await handleWeb2(content)

    let webResponse: IWeb2Attestation | null,
        dahr: DAHR,
        extra: string,
        require_reply = false

    // Managing the results
    if (fullResponse[0]) {
        dahr = fullResponse[1] as DAHR
        const localProxySource = "localhost:8000"
        // TODO FE needs to receive a DAHR instance and call this method somehow
        // TODO Create a interface to use as argument for the talkWithTarget method
        webResponse = await dahr.talkWithTarget(
            localProxySource,
            content,
            "/",
            EnumWeb2Methods.GET,
        )
        const request = dahr.web2Request
        console.log("[handleWeb2] request:")
        console.log(request)

        console.log("[handleWeb2] web2Promise:")
        console.log(response)
    } else {
        webResponse = null
        extra = fullResponse[1] as string
    }
    // Returning a proper response
    response.result = 200
    response.response = webResponse
    response.extra = dahr
    return response
}
