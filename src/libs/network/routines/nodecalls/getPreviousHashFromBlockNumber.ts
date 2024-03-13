import Chain from "src/libs/blockchain/chain"

export default async function getPreviousHashFromBlockNumber(data: any) {
    let response = null
    let extra = ""
    console.log("[SERVER] Received getPreviousHashFromBlockNumber")
    if (data.blockNumber === undefined || data.blockNumber < 0) {
        response = "error"
        extra = "Block number is not valid"
        return { response, extra }
    }
    response = await Chain.getBlockByNumber(data.blockNumber)
    console.log("[CHAIN.ts] Received reply from the database: got a block")
    response = response.content.previousHash
    return { response, extra }
}
