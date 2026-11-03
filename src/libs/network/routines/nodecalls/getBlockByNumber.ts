import { Blocks } from "@/model/entities/Blocks"
import { RPCResponse } from "@kynesyslabs/demosdk/types"
import Chain from "src/libs/blockchain/chain"
import log from "src/utilities/logger"

export default async function getBlockByNumber(
    data: any,
): Promise<RPCResponse> {
    // Block 0 is a valid height: a truthiness check refused a numeric 0.
    const raw = data?.blockNumber
    let blockNumber = Number.NaN
    if (typeof raw === "number") blockNumber = raw
    else if (typeof raw === "string" && /^\d+$/.test(raw)) blockNumber = Number(raw)
    if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) {
        log.error("[SERVER ERROR] Missing or invalid blockNumber")
        return {
            result: 400,
            response: "error",
            extra: "Block number not provided",
            require_reply: false,
        }
    } else {
        log.debug(`[SERVER] Received getBlockByNumber: ${blockNumber}`)

        let block: Blocks
        if (blockNumber === 0) {
            block = {
                number: 0,
                hash: await Chain.getGenesisBlockHash(),
            } as Partial<Blocks> as Blocks
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
