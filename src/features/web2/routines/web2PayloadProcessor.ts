import {
    IWeb2Request,
    EnumWeb2Methods,
} from "@kynesyslabs/demosdk/types"
import required from "src/utilities/required"
import { skeletons } from "@kynesyslabs/demosdk/websdk"

/**
 * Represents a simplified payload for Web2 proxy requests.
 */
interface ISimplifiedWeb2Payload {
    action?: string
    method: EnumWeb2Methods
    url: string
    headers?: Record<string, string>
    sessionId?: string
}

/**
 * Processes and normalizes the incoming payload for a Web2 proxy request.
 *
 * This function handles two types of payloads:
 * 1. A fully formed IWeb2Request object
 * 2. A simplified payload with just url and optional method
 *
 * @param {IWeb2Request | ISimplifiedWeb2Payload} payload - The incoming payload to process
 * @returns {IWeb2Request} A normalized IWeb2Request object
 * @throws {Error} If the payload structure is invalid or missing required fields
 */
export function processWeb2Payload(
    payload: IWeb2Request | ISimplifiedWeb2Payload,
): IWeb2Request {
    if (isFullWeb2Request(payload)) {
        validateFullWeb2Request(payload)
        return payload
    } else if (isSimplifiedPayload(payload)) {
        return createFullWeb2Request(payload)
    } else {
        throw new Error("Invalid payload structure")
    }
}

export function isFullWeb2Request(payload: any): payload is IWeb2Request {
    return payload.raw && typeof payload.raw.url === "string"
}

function isSimplifiedPayload(payload: any): payload is ISimplifiedWeb2Payload {
    return typeof payload.url === "string"
}

function validateFullWeb2Request(request: IWeb2Request): void {
    required(request.raw.url, "URL is required in Web2 request")
    required(
        Object.values(EnumWeb2Methods).includes(request.raw.method),
        "Invalid HTTP method",
    )
    // Add more validations as needed
}

function createFullWeb2Request(payload: ISimplifiedWeb2Payload): IWeb2Request {
    required(payload.url, "URL is required in simplified Web2 payload")
    required(payload.method, "Method is required in simplified Web2 payload")
    required(
        Object.values(EnumWeb2Methods).includes(payload.method),
        "Invalid HTTP method",
    )

    const web2Request = { ...skeletons.web2_request }

    web2Request.raw = {
        ...web2Request.raw,
        action: payload.action || "create",
        method: payload.method,
        url: payload.url,
        headers: payload.headers || {},
    }

    return web2Request
}
