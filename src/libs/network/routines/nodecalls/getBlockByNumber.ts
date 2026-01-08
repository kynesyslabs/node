import { Blocks } from "@/model/entities/Blocks"
import { RPCResponse } from "@kynesyslabs/demosdk/types"
import Chain from "src/libs/blockchain/chain"
import log from "src/utilities/logger"

export default async function getBlockByNumber(
    data: any,
): Promise<RPCResponse> {
    const blockNumber: number = data.blockNumber

    if (!blockNumber) {
        log.error("[SERVER ERROR] Missing blockNumber 💀")
        return {
            result: 400,
            response: "error",
            extra: "Block number not provided",
            require_reply: false,
        }
    } else {
        log.debug("[SERVER] Received getBlockByNumber: " + blockNumber)

        let block: Blocks
        if (blockNumber === 0) {
            // @ts-expect-error Block is not typed
            block = {
                number: 0,
                hash: await Chain.getGenesisBlockHash(),
            }
        } else {
            block = await Chain.getBlockByNumber(blockNumber)
        }

        if (block) {
            return {
                result: 200,
                response: block,
                require_reply: false,
                extra: "",
            }
        }

        return {
            result: 404,
            response: "error",
            extra: "Block not found",
            require_reply: false,
        }
    }
}
