import Chain from "src/libs/blockchain/chain"

export default async function getPreviousHashFromBlockHash(
    data: any,
): Promise<any> {
    let response = null
    let extra = ""
    console.log("[SERVER] Received getPreviousHashFromBlockNumber")
    if (data.blockHash === undefined || data.blockHash === "") {
        response = "error"
        extra = "Block hash is not valid"
        return { response, extra }
    }
    response = await Chain.getBlockByHash(data.blockHash)
    console.log("[CHAIN.ts] Received reply from the database: got a block")
    response = response.content.previousHash
    return response
}
