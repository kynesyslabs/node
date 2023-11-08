// INFO This module assign to each address its list of transactions
import Transaction from "src/libs/blockchain/transaction"


export default async function assignTxs(txs: Transaction[]): Promise<Map<string, string[]>> {
	let txs_per_address = new Map<string, string[]>()
	// TODO
	return txs_per_address
}