// INFO Module to order a list of Transactions based on the fees
import Transaction from "src/libs/blockchain/transaction"

export default async function orderTxs(
    txs: Transaction[],
): Promise<Transaction[]> {
    let orderedTxs: Transaction[] = []
    let ranking = {}
    let mapping = {}
    // Parsing all the transactions and building a ranking
    for (let i = 0; i < txs.length; i++) {
        let tx = txs[i]
        // Trivial but at least is clear
        let baseFee = tx.content.transaction_fee.network_fee
        let rpcFee = tx.content.transaction_fee.rpc_fee
        let additionalFee = tx.content.transaction_fee.additional_fee
        let totalFee = baseFee + rpcFee + additionalFee
        // Building the ranking
        ranking[tx.hash] = totalFee
        mapping[tx.hash] = tx
    }
    // Sorting the ranking
    let orderedTxsSortable: any[][]
    for (var txHash in ranking) {
        orderedTxsSortable.push([txHash, ranking[txHash]])
    }
    orderedTxsSortable.sort(function (a, b) {
        return a[1] - b[1]
    })
    // Assigning the transactions to the ordered transactions mapping
    for (let i = 0; i < orderedTxsSortable.length; i++) {
        let tx = mapping[orderedTxsSortable[i][0]]
        orderedTxs.push(tx)
        delete mapping[orderedTxsSortable[i][0]]
    }
    // We can return the ordered transactions
    return orderedTxs
}
