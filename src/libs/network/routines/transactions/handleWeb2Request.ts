import { IWeb2Request } from "@kynesyslabs/demosdk/types"
import handleWeb2 from "src/features/web2/Web2Dispatcher"

// ? Can we avoid calling another function pls?

export default async function handleWeb2Request(
    content: IWeb2Request,
    senderSocket: any,
): Promise<{ response: any; require_reply: boolean; extra: any }> {
    /* NOTE This workflow goeas as:
     * The Web2 Operation is validated, executed and verified
     * when applicable. Is then sent back once attested.
     * A transaction is derived from the executed web2 operation.
     * An operation is then created and pushed in the GLS.
     * An operation for the gas is also pushed in the GLS.
     * The tx is pushed in the mempool if applicable.
     */
    console.log("[SERVER] Received web2Request")
    //console.log(JSON.stringify(request))

    let extra: string,
        require_reply = false
    let response: IWeb2Request
    // We get our connection string
    // const currentPeerString = Identity.getInstance().getConnectionString()
    // NOTE Switched to the new class

    //console.log("[WEB2 CONTENT DUMP]")
    //console.log(content)
    let fullResponse = await handleWeb2(content, senderSocket)
    //console.log("[WEB2 CONTENT RESPONSE DUMP]")
    //console.log(fullResponse)

    // Managing the results
    if (fullResponse[0]) {
        response = fullResponse[1] as IWeb2Request
    } else {
        response = null
        extra = fullResponse[1] as string
    }
    return { extra, require_reply, response }
}