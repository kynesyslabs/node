import { RPCResponse } from "@kynesyslabs/demosdk/types"
import Chain from "src/libs/blockchain/chain"

interface IGetTransactionsData {
    start: number | "latest"
    limit: number
}

export default async function getTransactions(
    data: IGetTransactionsData,
): Promise<RPCResponse> {
    const start: number | string =
        data.start === "latest" || data.start === 0
            ? 0
            : Number(data.start) || 0
    const limit: number = data.limit || 50

    if (isNaN(start) || isNaN(limit)) {
        console.log("[SERVER ERROR] Invalid start or limit parameter value 💀")
        return {
            result: 400,
            response: "error",
            extra: "Invalid start or limit parameter value",
            require_reply: false,
        }
    } else {
        console.log(
            `[SERVER] Receiving request getAllTransactions: start=${start}, limit=${limit}`,
        )

        const transactions = await Chain.getTransactions(start, limit)

        if (transactions && transactions.length > 0) {
            return {
                result: 200,
                response: transactions,
                require_reply: false,
                extra: "",
            }
        }

        return {
            result: 404,
            response: "error",
            extra: "No transactions found",
            require_reply: false,
        }
    }
}
