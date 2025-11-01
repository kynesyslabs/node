import { OmniHandler } from "../../types/message"
import { decodeJsonRequest } from "../../serialization/jsonEnvelope"
import { encodeResponse, errorResponse } from "./utils"
import { encodeAddressInfoResponse } from "../../serialization/gcr"

interface AddressInfoRequest {
    address?: string
}

export const handleGetAddressInfo: OmniHandler = async ({ message }) => {
    if (!message.payload || message.payload.length === 0) {
        return encodeResponse(
            errorResponse(400, "Missing payload for getAddressInfo"),
        )
    }

    const payload = decodeJsonRequest<AddressInfoRequest>(message.payload)

    if (!payload.address) {
        return encodeResponse(errorResponse(400, "address is required"))
    }

    try {
        const { default: ensureGCRForUser } = await import(
            "src/libs/blockchain/gcr/gcr_routines/ensureGCRForUser"
        )
        const info = await ensureGCRForUser(payload.address)

        const balance = BigInt(
            typeof info.balance === "string"
                ? info.balance
                : info.balance ?? 0,
        )
        const nonce = BigInt(info.nonce ?? 0)
        const additional = Buffer.from(JSON.stringify(info), "utf8")

        return encodeAddressInfoResponse({
            status: 200,
            balance,
            nonce,
            additionalData: additional,
        })
    } catch (error) {
        return encodeResponse(
            errorResponse(400, "error", error instanceof Error ? error.message : error),
        )
    }
}
