import Chain from "src/libs/blockchain/chain"
import log from "src/utilities/logger"

export default async function getBlockHeaderByNumber(data: any) {
    let response = null
    let extra = ""
    if (
        data.blockNumber === undefined ||
        data.blockNumber < 0 ||
        data.blockNumber === ""
    ) {
        response = "error"
        extra = "Block number is not valid"
        return { response, extra }
    }
    response = await Chain.getBlockByNumber(data.blockNumber)
    log.debug(
        "[CHAIN.ts] Received reply from the database: extracting header",
    )
    // FIXME Implement the extraction of the header
    // response = response.getHeader()
    return { response, extra }
}