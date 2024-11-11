import { DAHR } from "src/features/web2/dahr/DAHR"
import { IWeb2Request, RPCResponse } from "@kynesyslabs/demosdk/types"
import { handleWeb2 } from "src/features/web2/handleWeb2"
import { DAHRFactory } from "src/features/web2/dahr/DAHRFactory"

/**
 * Handles the web2 proxy request.
 * @param {IWeb2Request} request - The web2 request or start proxy parameters.
 * @param {string} action - The action to perform.
 * @param {string} sessionId - The session ID.
 * @param {IWeb2Request["raw"]["headers"]} headers - The headers to send with the request.
 * @param {any} payload - The payload to send with the request.
 * @param {string} authorization - The authorization token to send with the request.
 * @returns {Promise<RPCResponse>} The RPC response.
 */
export async function handleWeb2ProxyRequest(
    request: IWeb2Request,
    sessionId: string = "",
    payload: any = {},
    authorization: string = "",
): Promise<RPCResponse> {
    try {
        switch (request.raw.action) {
            case "create": {
                const isDahrOrError = await handleWeb2(request)

                if (isDahrOrError instanceof DAHR) {
                    const dahr = isDahrOrError

                    return {
                        result: 200,
                        response: {
                            dahr: dahr.toSerializable(),
                        },
                        require_reply: false,
                        extra: null,
                    } as RPCResponse
                } else {
                    console.error(
                        "handleWeb2 did not return a DAHR instance:",
                        isDahrOrError,
                    )
                    return {
                        result: 400,
                        response: isDahrOrError,
                        require_reply: false,
                        extra: "An error occurred while handling the web2 request",
                    } as RPCResponse
                }
            }

            case "startProxy": {
                const dahr = _getDAHRInstance(sessionId)
                if (!dahr) {
                    return {
                        result: 400,
                        response: null,
                        require_reply: false,
                        extra: "DAHR instance not found",
                    } as RPCResponse
                }
                const { method, headers } = request.raw
                const response = await dahr.startProxy(
                    method,
                    headers,
                    payload,
                    authorization,
                )
                return {
                    result: 200,
                    response: response,
                    require_reply: false,
                    extra: null,
                } as RPCResponse
            }

            case "stopProxy": {
                const dahr = _getDAHRInstance(sessionId)
                if (!dahr) {
                    return {
                        result: 400,
                        response: null,
                        require_reply: false,
                        extra: "DAHR instance not found",
                    } as RPCResponse
                }
                dahr.stopProxy()
                return {
                    result: 200,
                    response: { message: "Proxy stopped successfully" },
                    require_reply: false,
                    extra: null,
                } as RPCResponse
            }
            default: {
                return {
                    result: 400,
                    response: null,
                    require_reply: false,
                    extra: `Unsupported action: ${request.raw.action}`,
                } as RPCResponse
            }
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

/**
 * Retrieves the DAHR instance for the given session ID.
 * @param sessionId - The session ID.
 * @returns The DAHR instance or null if not found.
 */
function _getDAHRInstance(sessionId: string): DAHR | null {
    const dahr = DAHRFactory.instance.getDAHR(sessionId)
    if (!dahr) {
        console.error(`DAHR instance not found for sessionId: ${sessionId}`)
        return null
    }
    return dahr
}
