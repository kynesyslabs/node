import { IWeb2Payload } from "@kynesyslabs/demosdk/types"
import { skeletons } from "@kynesyslabs/demosdk/websdk"
import required from "@/utilities/required"

/**
 * Parses a web2 proxy request.
 * @param rawPayload - The raw payload.
 * @returns The parsed web2 proxy request.
 */
export function parseWeb2ProxyRequest(
    rawPayload: IWeb2Payload,
): IWeb2Payload["message"] {
    required(rawPayload.message, "Web2 proxy request message is required")

    const {
        sessionId,
        payload: payloadData,
        authorization,
        ...messageData
    } = rawPayload.message

    const web2Request = { ...skeletons.web2_request }
    web2Request.raw = {
        ...web2Request.raw,
        ...messageData.web2Request.raw,
    }

    return {
        sessionId,
        payload: payloadData,
        web2Request,
        authorization,
    }
}
