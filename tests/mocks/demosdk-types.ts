export type RPCRequest = {
    method: string
    params: unknown[]
}

export type RPCResponse = {
    result: number
    response: unknown
    require_reply: boolean
    extra: unknown
}

export type SigningAlgorithm = string

export interface IPeer {
    connection: { string: string }
    identity: string
    verification: {
        status: boolean
        message: string | null
        timestamp: number | null
    }
    sync: { status: boolean; block: number; block_hash: string }
    status: { online: boolean; timestamp: number | null; ready: boolean }
}

export type Transaction = Record<string, unknown>
export type TransactionContent = Record<string, unknown>
export type NativeTablesHashes = Record<string, unknown>
export type Web2GCRData = Record<string, unknown>
export type XMScript = Record<string, unknown>
export type Tweet = Record<string, unknown>
export type DiscordMessage = Record<string, unknown>
export type IWeb2Request = Record<string, unknown>
export type IOperation = Record<string, unknown>
export type EncryptedTransaction = Record<string, unknown>
export type BrowserRequest = Record<string, unknown>
export type ValidationData = Record<string, unknown>
export type UserPoints = Record<string, unknown>
