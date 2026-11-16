import { featureDisabledMessage } from "src/libs/network/outboundSwitches"
import { DAHR } from "src/features/web2/dahr/DAHR"
import {
    EnumWeb2Actions,
    RPCResponse,
    IWeb2Payload,
    IWeb2Result,
} from "@kynesyslabs/demosdk/types"
import { handleWeb2 } from "src/features/web2/handleWeb2"
import { DAHRFactory } from "src/features/web2/dahr/DAHRFactory"
import { validateAndNormalizeHttpUrl } from "src/features/web2/validator"
import {
    allowsNonSuccessStatus,
    UnattestableResponseError,
} from "src/features/web2/dahr/originStatus"
import {
    Web2FetchLimiter,
    WEB2_FETCH_LIMITED,
    type Web2FetchCaller,
} from "src/features/web2/web2FetchLimiter"
import type { Web2FetchMeter } from "src/features/web2/proxy/Proxy"
import log from "src/utilities/logger"

type IHandleWeb2ProxyRequestStepParams = Pick<
    IWeb2Payload["message"],
    "web2Request"
> &
    Partial<Omit<IWeb2Payload["message"], "web2Request">>

/**
 * Handles the web2 proxy request.
 *
 * `caller` is who the outbound fetch is counted against: the client address
 * for an RPC call, the sender for a tx. Without one the fetch still takes a
 * node-wide slot.
 * @returns {Promise<RPCResponse>} The RPC response.
 */
// eslint-disable-next-line no-redeclare
export async function handleWeb2ProxyRequest(
    {
        web2Request,
        sessionId,
        payload,
        authorization,
    }: IWeb2Payload["message"] | IHandleWeb2ProxyRequestStepParams,
    caller?: Web2FetchCaller,
): Promise<RPCResponse> {
    const disabled = featureDisabledMessage("web2")
    if (disabled) return createRPCResponse(403, null, disabled)

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

                const validation = validateAndNormalizeHttpUrl(
                    web2Request.raw.url,
                )
                if (!validation.ok) {
                    // Explicit narrowing needed due to strictNullChecks: false
                    const failed = validation as {
                        ok: false
                        status: 400
                        message: string
                    }
                    return createRPCResponse(
                        failed.status,
                        null,
                        failed.message,
                    )
                }

                dahr.web2Request.raw = {
                    ...dahr.web2Request.raw,
                    url: validation.normalizedUrl,
                }

                const { method, headers } = web2Request.raw

                const admission = Web2FetchLimiter.instance.acquire(caller)
                if (!admission.lease) {
                    const { reason, retryAfterSeconds, message } =
                        admission.refusal
                    return createRPCResponse(
                        429,
                        { error: WEB2_FETCH_LIMITED, reason, retryAfterSeconds },
                        message,
                    )
                }

                const meter: Web2FetchMeter = { bytes: 0 }
                let response: IWeb2Result
                try {
                    response = await dahr.startProxy({
                        method,
                        headers,
                        payload,
                        authorization,
                        url: validation.normalizedUrl,
                        // Read from the incoming request: it is the one the
                        // client signs into the web2Request tx.
                        allowNonSuccessStatus: allowsNonSuccessStatus(
                            web2Request.raw,
                        ),
                        meter,
                    })
                } catch (error) {
                    if (error instanceof UnattestableResponseError) {
                        // `response` stays null: SDKs that skip the result
                        // check then fail before signing a tx, instead of
                        // anchoring an empty result.
                        return createRPCResponse(
                            error.rpcStatus,
                            null,
                            error.message,
                        )
                    }
                    throw error
                } finally {
                    admission.lease.release(meter.bytes)
                }

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
    } catch (error) {
        log.error("Error in handleWeb2ProxyRequest: " + error)
        const errorMsg = error instanceof Error ? error.message : String(error)
        return createRPCResponse(500, error, errorMsg)
    }
}

function getDAHRInstance(sessionId: string): DAHR | null {
    const dahr = DAHRFactory.instance.getDAHR(sessionId)
    if (!dahr) {
        log.error(`DAHR instance not found for sessionId: ${sessionId}`)
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
