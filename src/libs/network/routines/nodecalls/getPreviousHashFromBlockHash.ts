import Chain from "src/libs/blockchain/chain"
import log from "src/utilities/logger"

export default async function getPreviousHashFromBlockHash(
    data: any,
): Promise<any> {
    let response = null
    let extra = ""
    log.debug("[SERVER] Received getPreviousHashFromBlockNumber")
    if (data.blockHash === undefined || data.blockHash === "") {
        response = "error"
        extra = "Block hash is not valid"
        return { response, extra }
    }
    response = await Chain.getBlockByHash(data.blockHash)
    log.debug("[CHAIN.ts] Received reply from the database: got a block")
    response = response.content.previousHash
    return response
}
