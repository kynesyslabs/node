import forge, { pki } from "node-forge"

export interface TransactionContent {
    type: string
    from: forge.pki.ed25519.BinaryBuffer
    to: forge.pki.ed25519.BinaryBuffer
    amount: number
    data: [string, string] // type as string and content in hex string
    nonce: number // Increments every time a transaction is sent from the same account
    timestamp: number // Is the registered unix timestamp when the transaction was sent the first time
}
