import { EnumWeb2Methods } from "src/features/web2/dahr/Proxy"
import { DAHR } from "src/features/web2/dahr/DAHR"
import { RPCResponse } from "@kynesyslabs/demosdk/types"
import { handleWeb2 } from "src/features/web2/handleWeb2"
import required from "src/utilities/required"
import { processWeb2Payload } from "src/features/web2/routines/web2PayloadProcessor"

/**
 * Represents a simplified payload for Web2 proxy requests.
 */
interface ISimplifiedWeb2Payload {
    dahrId?: string
    url: string
    method?: EnumWeb2Methods
    headers?: Record<string, string>
}

export async function handleWeb2ProxyRequest(
    payload: any,
): Promise<RPCResponse> {
    const SERVER_PORT_PROXY = process.env.SERVER_PORT_PROXY || "53550" //TODO Revise this for production
    required(
        /^\d+$/.test(SERVER_PORT_PROXY),
        "SERVER_PORT_PROXY must be a valid port number",
    )

    const request = processWeb2Payload(payload)

    try {
        const dahrOrError = await handleWeb2(request)

        if (dahrOrError instanceof DAHR) {
            const dahr = dahrOrError
            const response = await dahr.talkWithTarget(
                `localhost:${SERVER_PORT_PROXY}`,
                "/",
                dahr.web2Request.raw.method as EnumWeb2Methods,
            )

            return {
                result: 200,
                response: {
                    attestation: response,
                    targetResponse: response.targetResponse,
                },
                require_reply: false,
                extra: null,
            }
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
            }
        }
    } catch (error: any) {
        console.error("Error in handleWeb2ProxyRequest:", error)

        return {
            result: 500,
            response: error,
            require_reply: false,
            extra: error.message,
        }
    }
}
