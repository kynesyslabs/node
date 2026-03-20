import Chain from "src/libs/blockchain/chain"
import log from "src/utilities/logger"

export default async function getBlockByHash(data: any) {
    let response = null
    let extra = ""

    if (!data.hash) {
        log.error("[SERVER ERROR] Missing hash 💀")
        response = "error"
        extra = "Missing hash"
        return { response, extra }
    }
    log.debug("[SERVER] Received getBlockByHash: " + data.hash)
    response = await Chain.getBlockByHash(data.hash)
    return { response, extra }
}
