import forge, { pki } from "node-forge"

export interface TransactionContent {
    type: string
    from: forge.pki.ed25519.PublicKey
    to: forge.pki.ed25519.PublicKey
    amount: number
    data: number
}
