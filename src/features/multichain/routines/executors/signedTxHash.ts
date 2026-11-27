import { createHash } from "node:crypto"

const APTOS_TX_SALT = createHash("sha3-256").update("APTOS::Transaction").digest()
// "TXN\0": the XRPL hash prefix for a signed transaction.
const XRPL_TX_PREFIX = Buffer.from("54584e00", "hex")

/**
 * The hash Aptos gives a signed user transaction: sha3-256 over the
 * "APTOS::Transaction" salt, the UserTransaction variant tag (0) and the BCS
 * bytes. Known before submission, so a submit with no answer can still name it.
 */
export function aptosSignedTxHash(signedTxBytes: Uint8Array): string {
    const digest = createHash("sha3-256")
        .update(APTOS_TX_SALT)
        .update(Uint8Array.of(0))
        .update(signedTxBytes)
        .digest("hex")
    return "0x" + digest
}

/** The XRPL transaction id of a signed tx_blob: SHA-512Half of "TXN\0" || blob. */
export function xrplSignedTxHash(txBlobHex: string): string {
    return createHash("sha512")
        .update(XRPL_TX_PREFIX)
        .update(Buffer.from(txBlobHex, "hex"))
        .digest()
        .subarray(0, 32)
        .toString("hex")
        .toUpperCase()
}
