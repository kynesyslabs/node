import Chain from "src/libs/blockchain/chain"

export default async function getBlockByNumber(data: any) {

    let response: any = null
    let extra: any = ""

    if (
        data.blockNumber === undefined ||
        data.blockNumber === null
    ) {
        console.log("[SERVER ERROR] Missing blockNumber 💀")
        response = "error"
        extra = "Missing blockNumber"
        return { response, extra }
    } else {
        console.log(
            "[SERVER] Received getBlockByNumber: " +
                data.blockNumber,
        )
        response = await Chain.getBlockByNumber(data.blockNumber)

        // REVIEW Debug lines
        //console.log(response)
        //response = JSON.stringify(response)
        //console.log(response)
    }

    return { response, extra }
}