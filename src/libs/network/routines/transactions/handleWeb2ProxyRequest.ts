import { DAHR } from "src/features/web2/dahr/DAHR"
import {
    EnumWeb2Actions,
    RPCResponse,
    IWeb2Payload,
} from "@kynesyslabs/demosdk/types"
import { handleWeb2 } from "src/features/web2/handleWeb2"
import { DAHRFactory } from "src/features/web2/dahr/DAHRFactory"

type IHandleWeb2ProxyRequestStepParams = Pick<
    IWeb2Payload["message"],
    "web2Request"
> &
    Partial<Omit<IWeb2Payload["message"], "web2Request">>

/**
 * Handles the web2 proxy request.
 * @returns {Promise<RPCResponse>} The RPC response.
 */
// eslint-disable-next-line no-redeclare
export async function handleWeb2ProxyRequest({
    web2Request,
    sessionId,
    payload,
    authorization,
}:
    | IWeb2Payload["message"]
    | IHandleWeb2ProxyRequestStepParams): Promise<RPCResponse> {
    try {
        switch (web2Request.raw.action) {
            case EnumWeb2Actions.CREATE: {
                const isDahrOrError = await handleWeb2(web2Request)
                if (isDahrOrError instanceof DAHR) {
                    const dahr = isDahrOrError.toSerializable()

                    return createRPCResponse(200, {
                        dahr,
                    })
                }

                const error = isDahrOrError

                return createRPCResponse(
                    400,
                    error,
                    "An error occurred while handling the web2 request",
                )
            }

            case EnumWeb2Actions.START_PROXY: {
                const dahr = getDAHRInstance(sessionId)
                if (!dahr) {
                    return createRPCResponse(
                        400,
                        null,
                        "DAHR instance not found",
                    )
                }

                // Validate URL scheme: only http(s) are allowed
                try {
                    const parsed = new URL(web2Request.raw.url)
                    if (
                        parsed.protocol !== "http:" &&
                        parsed.protocol !== "https:"
                    ) {
                        return createRPCResponse(
                            400,
                            null,
                            `Invalid URL scheme: ${parsed.protocol}. Only http(s) are allowed.`,
                        )
                    }
                } catch {
                    return createRPCResponse(
                        400,
                        null,
                        `Invalid URL format: ${web2Request.raw.url}`,
                    )
                }

                dahr.web2Request.raw = {
                    ...dahr.web2Request.raw,
                    url: web2Request.raw.url,
                }

                const { method, headers } = web2Request.raw

                const response = await dahr.startProxy({
                    method,
                    headers,
                    payload,
                    authorization,
                    url: web2Request.raw.url,
                })

                return createRPCResponse(200, response)
            }

            default: {
                return createRPCResponse(
                    400,
                    null,
                    `Unsupported action: ${web2Request.raw.action}`,
                )
            }
        }
    } catch (error: any) {
        console.error("Error in handleWeb2ProxyRequest:", error)

        return createRPCResponse(500, error, error.message)
    }
}

function getDAHRInstance(sessionId: string): DAHR | null {
    const dahr = DAHRFactory.instance.getDAHR(sessionId)
    if (!dahr) {
        console.error(`DAHR instance not found for sessionId: ${sessionId}`)
        return null
    }
    return dahr
}

function createRPCResponse(
    result: number,
    response: unknown,
    extra: string | null = null,
): RPCResponse {
    return {
        result,
        response,
        require_reply: false,
        extra,
    }
}
