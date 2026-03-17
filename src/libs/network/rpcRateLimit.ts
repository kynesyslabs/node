import { RPCRequest } from "@kynesyslabs/demosdk/types"
import { getSharedState } from "src/utilities/sharedState"
import { RateLimiter } from "./middleware/rateLimiter"

/**
 * Rate limit identity transactions per IP address per block.
 *
 * @returns Response if rate limit is exceeded, otherwise null
 */
export function handleIdentityTxRateLimit(
    req: Request,
    ip: string,
    payload: RPCRequest,
    rateLimiter: RateLimiter,
) {
    if (rateLimiter.isTrustedInternalRequest(req, ip)) {
        return null
    }

    const ipData = rateLimiter.ipRequests.get(ip)
    if (!ipData) {
        return new Response(
            JSON.stringify({
                error: "Rate limiter: IP address not resolved",
            }),
            { status: 400 },
        )
    }

    if (payload.method !== "execute") {
        return null
    }

    const rateFirstParam = payload.params?.[0]
    if (!rateFirstParam) {
        return null
    }

    if (rateFirstParam.extra !== "confirmTx") {
        return null
    }

    const contentData = rateFirstParam.data?.content?.data?.[0]
    if (contentData !== "identity") {
        return null
    }

    const currentBlockNumber = getSharedState.lastBlockNumber

    if (ipData.lastSeenBlockNumber === currentBlockNumber) {
        ipData.lastSeenWithinBlockCount++
    } else {
        ipData.lastSeenWithinBlockCount = 1
        ipData.lastSeenBlockNumber = currentBlockNumber
    }

    if (ipData.lastSeenWithinBlockCount > rateLimiter.config.txPerBlock) {
        rateLimiter.ipRequests.set(ip, ipData)

        return new Response(
            JSON.stringify({
                error: "Rate limit exceeded",
                retryAfter: null,
            }),
            { status: 429 },
        )
    }

    return null
}
