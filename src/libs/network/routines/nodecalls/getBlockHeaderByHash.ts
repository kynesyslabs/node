import Chain from "src/libs/blockchain/chain"
import log from "src/utilities/logger"

export default async function getBlockHeaderByHash(data: any) {
    let response = null
    let extra = ""
    if (data.blockHash === undefined || data.blockHash === "") {
        response = "error"
        extra = "Block hash is not valid"
    }
    response = await Chain.getBlockByHash(data.blockHash)
    log.debug("[CHAIN.ts] Received reply from the database: extracting header")
    // FIXME Implement the extraction of the header
    // response = response.getHeader()
    //console.log(response)
    return { response, extra }
}
