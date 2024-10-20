import { EnumWeb2Methods } from "src/features/web2/proxy/Proxy"
import { DAHR } from "src/features/web2/dahr/DAHR"
import { IWeb2Request, RPCResponse } from "@kynesyslabs/demosdk/types"
import { handleWeb2 } from "src/features/web2/handleWeb2"
import { processWeb2Payload } from "src/features/web2/routines/web2PayloadProcessor"

export async function handleWeb2ProxyRequest(
    payload: IWeb2Request,
): Promise<RPCResponse> {
    const request = processWeb2Payload(payload)

    try {
        const dahrOrError = await handleWeb2(request)

        if (dahrOrError instanceof DAHR) {
            const dahr = dahrOrError
            const response = await dahr.talkWithTarget(
                "/",
                dahr.web2Request.raw.method as EnumWeb2Methods,
            )

            return {
                result: 200,
                response: {
                    dahr: dahr.toSerializable(),
                    response,
                },
                require_reply: false,
                extra: null,
            } as RPCResponse
        } else {
            const dahrError = dahrOrError
            console.error(
                "handleWeb2 did not return a DAHR instance:",
                dahrOrError,
            )

            return {
                result: 400,
                response: dahrError,
                require_reply: false,
                extra: "An error occurred while handling the web2 request",
            } as RPCResponse
        }
    } catch (error: any) {
        console.error("Error in handleWeb2ProxyRequest:", error)

        return {
            result: 500,
            response: error,
            require_reply: false,
            extra: error.message,
        } as RPCResponse
    }
}
