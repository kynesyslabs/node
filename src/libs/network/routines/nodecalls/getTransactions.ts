import { RPCResponse } from "@kynesyslabs/demosdk/types"
import Chain from "src/libs/blockchain/chain"

interface IGetTransactionsData {
    start: number | "latest"
    limit: number
}

export default async function getTransactions(
    data: IGetTransactionsData,
): Promise<RPCResponse> {
    const params = [data.start, data.limit].map((value, index) => {
        if (index === 0 && value === "latest") {
            return "latest"
        } else if (typeof value === "number") {
            return value
        } else {
            return null
        }
    })

    if (params.includes(null)) {
        return {
            result: 400,
            response: [],
            extra: "Error: Invalid start or limit parameter value",
            require_reply: false,
        }
    }

    const [start, limit] = params

    console.log(
        `[SERVER] Receiving request getAllTransactions: start=${start}, limit=${limit}`,
    )

    const transactions = await Chain.getTransactions(start, limit as any)

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
    // }
}
