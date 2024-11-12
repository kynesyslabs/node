import { IWeb2Request, EnumWeb2Methods } from "@kynesyslabs/demosdk/types"
import required from "src/utilities/required"
import { skeletons } from "@kynesyslabs/demosdk/websdk"

/**
 * Represents a simplified payload for Web2 proxy requests.
 */
interface ISimplifiedWeb2Payload {
    action?: string
    method: EnumWeb2Methods
    url: string
    headers?: IWeb2Request["raw"]["headers"]
    parameters?: IWeb2Request["raw"]["parameters"]
}

/**
 * Processes and normalizes the incoming payload for a Web2 proxy request.
 *
 * @param {ISimplifiedWeb2Payload} payload - The incoming payload to process
 * @returns {IWeb2Request} A normalized IWeb2Request object
 * @throws {Error} If the payload structure is invalid or missing required fields
 */
export function processWeb2Payload(
    payload: ISimplifiedWeb2Payload,
): IWeb2Request {
    required(payload.url, "URL is required in simplified Web2 payload")
    required(payload.method, "Method is required in simplified Web2 payload")
    required(
        Object.values(EnumWeb2Methods).includes(payload.method),
        "Invalid HTTP method",
    )

    const web2Request = { ...skeletons.web2_request }

    web2Request.raw = {
        ...web2Request.raw,
        action: payload.action || "",
        method: payload.method,
        url: payload.url,
        headers: payload.headers || {},
        parameters: payload.parameters || [],
    }

    return web2Request
}
