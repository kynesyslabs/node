import Transaction from "@/libs/blockchain/transaction"
import { Transaction as SDKTransaction } from "@kynesyslabs/demosdk/types"

// Local type definition for mempool data structure
interface MempoolData {
    transactions: SDKTransaction[]
}

export async function orderTransactions(
    mempool: MempoolData,
): Promise<Transaction[]> {
    // NOTE Sort transactions by timestamp
    // Explanation:
    // 1. We use the built-in Array.sort() method to order the transactions.
    // 2. The sort function compares timestamps of two transactions (a and b).
    // 3. If a's timestamp is smaller, it returns a negative number, placing a before b.
    // 4. If b's timestamp is smaller, it returns a positive number, placing b before a.
    // 5. If timestamps are equal, it returns 0, maintaining their relative order.
    // 6. This results in an array sorted in ascending order by timestamp.
    // NOTE This approach is more efficient and readable than the original implementation.
    // It avoids the need for manual insertion and has O(n log n) time complexity.
    const orderedTransactionsObjects: Transaction[] = mempool.transactions.sort(
        (a, b) => {
            const timeDiff = a.content.timestamp - b.content.timestamp
            if (timeDiff !== 0) return timeDiff
            // Deterministic tiebreaker: sort by hash when timestamps are equal
            return a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0
        },
    )
    // Stringify the transactions
    const orderedTransactions = orderedTransactionsObjects.map(
        transaction => transaction,
    )
    return orderedTransactions
}
