import forge, { pki } from "node-forge"

export interface BundleContent {
    type: string
    message: string
    sender: forge.pki.ed25519.PublicKey
    receiver: forge.pki.ed25519.PublicKey
    timestamp: number
    data: Buffer
    extra: Buffer
}

export interface Bundle {
    content: BundleContent
    hash: string
    signature: forge.pki.ed25519.Signature
}
