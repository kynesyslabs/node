import zlib from "zlib"
import Transaction from "src/libs/blockchain/transaction"
import required from "src/utilities/required"

export function compressData(tx: Transaction): Transaction {
	let stringified_content_data = JSON.stringify(tx.content.data)
	const compressed = zlib.deflateSync(stringified_content_data).toString("base64")
    tx.content.data = ["compressed_data", compressed]
    return tx
}

export function decompressData(tx: Transaction): Transaction {
	required(tx.content.data[0] === "compressed_data", "Does not look compressed")
	const decompressed = zlib.inflateSync(Buffer.from(tx.content.data[1], "base64")).toString()
	tx.content.data = JSON.parse(decompressed)
	return tx
}
