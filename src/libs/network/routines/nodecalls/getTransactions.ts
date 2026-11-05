import { RPCResponse } from "@kynesyslabs/demosdk/types"
import Chain from "src/libs/blockchain/chain"
import log from "src/utilities/logger"

const MAX_PAGE = 100

function toWireRow<T extends object>(row: T): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
            key,
            typeof value === "bigint" ? value.toString() : value,
        ]),
    )
}

interface InterfaceGetTransactionsData {
    start: number | "latest"
    limit: number
}

export default async function getTransactions(
    data: InterfaceGetTransactionsData,
): Promise<RPCResponse> {
    // The SDK's getTransactions() leaves both optional.
    const params = [data?.start ?? "latest", data?.limit ?? MAX_PAGE].map((value, index) => {
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

    log.debug(
        `[SERVER] Receiving request getAllTransactions: start=${start}, limit=${limit}`,
    )

    if (
        !Number.isSafeInteger(limit) || (limit as number) < 1 ||
        (start !== "latest" && (!Number.isSafeInteger(start) || (start as number) < 0))
    ) {
        return {
            result: 400,
            response: [],
            extra: "Error: Invalid start or limit parameter value",
            require_reply: false,
        }
    }

    // Same page cap as getTransactionHistory, enforced where the request
    // is parsed rather than left to the storage layer.
    const transactions = await Chain.getTransactions(
        start,
        Math.min(limit as number, MAX_PAGE),
    )

    if (transactions && transactions.length > 0) {
        return {
            result: 200,
            // Amount and fee columns load as bigint, which JSON cannot
            // carry: every non-empty page failed to serialise.
            response: transactions.map(toWireRow),
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
