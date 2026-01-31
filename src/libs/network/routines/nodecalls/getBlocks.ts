import { RPCResponse } from "@kynesyslabs/demosdk/types"
import Chain from "src/libs/blockchain/chain"
import log from "src/utilities/logger"

interface InterfaceGetBlocksData {
    start: number | "latest"
    limit: number
}

export default async function getBlocks(
    data: InterfaceGetBlocksData,
): Promise<RPCResponse> {
    const params = [data.start, data.limit].map((value, index) => {
        if (index === 0 && value === "latest") {
            return "latest"
        } else if (typeof value === "number") {
            return value
        } else {
            return null
        }
    })

    if (params.includes(null)) {
        return {
            result: 400,
            response: [],
            extra: "Error: Invalid start or limit parameter value",
            require_reply: false,
        }
    }

    const [start, limit] = params

    log.debug(`[SERVER] Received getBlocks: start=${start}, limit=${limit}`)

    const blocks = await Chain.getBlocks(start, limit as any)

    if (blocks && blocks.length > 0) {
        return {
            result: 200,
            response: blocks,
            require_reply: false,
            extra: "",
        }
    }

    return {
        result: 404,
        response: "error",
        extra: "No blocks found",
        require_reply: false,
    }
}
