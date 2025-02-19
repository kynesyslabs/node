import { RPCResponse } from "@kynesyslabs/demosdk/types"
import Chain from "src/libs/blockchain/chain"

interface IGetBlocksData {
    start: number | "latest"
    limit: number
}

export default async function getBlocks(
    data: IGetBlocksData,
): Promise<RPCResponse> {
    const start: number | string =
        data.start === "latest" || data.start === 0
            ? 0
            : Number(data.start) || 0
    const limit: number = data.limit || 50

    if (isNaN(start) || isNaN(limit)) {
        console.log("[SERVER ERROR] Invalid start or limit parameter value 💀")
        return {
            result: 400,
            response: "error",
            extra: "Invalid start or limit parameter value",
            require_reply: false,
        }
    } else {
        console.log(
            `[SERVER] Received getBlocks: start=${start}, limit=${limit}`,
        )

        const blocks = await Chain.getBlocks(start, limit)

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
}
