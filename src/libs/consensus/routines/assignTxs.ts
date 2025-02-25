// INFO This module assign to each address its list of transactions
import Transaction from "src/libs/blockchain/transaction"

export default async function assignTxs(
    txs: Transaction[],
): Promise<Map<string, string[]>> {
    const txsPerAddress = new Map<string, string[]>()
    // TODO
    return txsPerAddress
}
