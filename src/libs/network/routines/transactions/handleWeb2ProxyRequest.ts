import { DAHR } from "src/features/web2/dahr/DAHR"
import { IWeb2Request, RPCResponse } from "@kynesyslabs/demosdk/types"
import { handleWeb2 } from "src/features/web2/handleWeb2"
import { DAHRFactory } from "src/features/web2/dahr/DAHRFactory"

// TODO: Get from SDK
export enum EnumWeb2Actions {
    CREATE = "create",
    START_PROXY = "startProxy",
    STOP_PROXY = "stopProxy",
}

// TODO: Get from SDK
export interface IHandleWeb2ProxyRequestParams {
    request: IWeb2Request
    sessionId: string
    payload: unknown
    authorization: string
}

type IHandleWeb2ProxyRequestStepParams = Pick<
    IHandleWeb2ProxyRequestParams,
    "request"
> &
    Partial<Omit<IHandleWeb2ProxyRequestParams, "request">>

/**
 * Handles the web2 proxy request.
 * @returns {Promise<RPCResponse>} The RPC response.
 */
// eslint-disable-next-line no-redeclare
export async function handleWeb2ProxyRequest({
    request,
    sessionId,
    payload,
    authorization,
}:
    | IHandleWeb2ProxyRequestParams
    | IHandleWeb2ProxyRequestStepParams): Promise<RPCResponse> {
    try {
        switch (request.raw.action) {
            case EnumWeb2Actions.CREATE: {
                const isDahrOrError = await handleWeb2(request)
                if (isDahrOrError instanceof DAHR) {
                    const dahr = isDahrOrError.toSerializable()

                    return _createRPCResponse(200, {
                        dahr,
                    })
                }

                const error = isDahrOrError

                return _createRPCResponse(
                    400,
                    error,
                    "An error occurred while handling the web2 request",
                )
            }

            case EnumWeb2Actions.START_PROXY: {
                const dahr = _getDAHRInstance(sessionId)
                if (!dahr) {
                    return _createRPCResponse(
                        400,
                        null,
                        "DAHR instance not found",
                    )
                }

                dahr.web2Request.raw = {
                    ...dahr.web2Request.raw,
                    url: request.raw.url,
                }

                const { method, headers } = request.raw
                const response = await dahr.startProxy({
                    method,
                    headers,
                    payload,
                    authorization,
                })
                return _createRPCResponse(200, response)
            }

            case EnumWeb2Actions.STOP_PROXY: {
                const dahr = _getDAHRInstance(sessionId)
                if (!dahr) {
                    return _createRPCResponse(
                        400,
                        null,
                        "DAHR instance not found",
                    )
                }

                dahr.stopProxy()
                return _createRPCResponse(200, {
                    message: "Proxy stopped successfully",
                })
            }
            default: {
                return _createRPCResponse(
                    400,
                    null,
                    `Unsupported action: ${request.raw.action}`,
                )
            }
        }
    } catch (error: any) {
        console.error("Error in handleWeb2ProxyRequest:", error)

        return _createRPCResponse(500, error, error.message)
    }
}

function _getDAHRInstance(sessionId: string): DAHR | null {
    const dahr = DAHRFactory.instance.getDAHR(sessionId)
    if (!dahr) {
        console.error(`DAHR instance not found for sessionId: ${sessionId}`)
        return null
    }
    return dahr
}

function _createRPCResponse(
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
