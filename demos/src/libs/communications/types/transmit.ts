import forge, { pki } from "node-forge"

export interface BundleContent {
    type: string
    message: string
    sender: any // TODO improve interface
    receiver: any // TODO improve interface
    timestamp: number
    data: Buffer
    extra: Buffer
}

export interface Bundle {
    content: BundleContent
    hash: string
    signature: any // TODO improve interface
}
