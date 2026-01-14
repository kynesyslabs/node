import Chain from "src/libs/blockchain/chain"
import log from "src/utilities/logger"

export default async function getPreviousHashFromBlockNumber(data: any) {
    let response = null
    let extra = ""
    log.debug("[SERVER] Received getPreviousHashFromBlockNumber")
    if (data.blockNumber === undefined || data.blockNumber < 0) {
        response = "error"
        extra = "Block number is not valid"
        return { response, extra }
    }
    response = await Chain.getBlockByNumber(data.blockNumber)
    log.debug("[CHAIN.ts] Received reply from the database: got a block")
    response = response.content.previousHash
    return { response, extra }
}
