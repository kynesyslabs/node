// INFO Module to order a list of Transactions based on the fees
import Transaction from "src/libs/blockchain/transaction"

export default async function orderTxs(
    txs: Transaction[],
): Promise<Transaction[]> {
    const orderedTxs: Transaction[] = []
    const ranking = {}
    const mapping = {}
    // Parsing all the transactions and building a ranking
    for (let i = 0; i < txs.length; i++) {
        const tx = txs[i]
        // Trivial but at least is clear
        const baseFee = tx.content.transaction_fee.network_fee
        const rpcFee = tx.content.transaction_fee.rpc_fee
        const additionalFee = tx.content.transaction_fee.additional_fee
        const totalFee = baseFee + rpcFee + additionalFee
        // Building the ranking
        ranking[tx.hash] = totalFee
        mapping[tx.hash] = tx
    }
    // Sorting the ranking
    const orderedTxsSortable: any[][] = []
    for (const txHash in ranking) {
        orderedTxsSortable.push([txHash, ranking[txHash]])
    }
    if (orderedTxsSortable && orderedTxsSortable.length > 0) {
        orderedTxsSortable.sort(function (a, b) {
            return a[1] - b[1]
        })
    }
    // Assigning the transactions to the ordered transactions mapping
    for (let i = 0; i < orderedTxsSortable.length; i++) {
        const tx = mapping[orderedTxsSortable[i][0]]
        orderedTxs.push(tx)
        delete mapping[orderedTxsSortable[i][0]]
    }
    // We can return the ordered transactions
    return orderedTxs
}
