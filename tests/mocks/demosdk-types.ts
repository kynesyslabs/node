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

// StorageProgram types used by GCRStorageProgramRoutines
export interface GCREdit {
    target: string
    type: string
    context: {
        sender: string
        data?: Record<string, unknown>
    }
    txhash: string
}

export interface GCREditStorageProgram extends GCREdit {
    type: "storageProgram"
    context: {
        sender: string
        data?: {
            variables?: StorageProgramPayload & {
                field?: string
                index?: number
                value?: unknown
            }
            metadata?: Record<string, unknown>
        }
    }
}

export interface StorageProgramPayload {
    operation: string
    storageAddress: string
    programName?: string
    encoding?: "json" | "binary"
    data?: Record<string, unknown> | string | null
    acl?: {
        mode: string
        allowed?: string[]
        blacklisted?: string[]
        groups?: Record<
            string,
            { members: string[]; permissions: string[] }
        >
    }
    metadata?: Record<string, unknown> | null
    storageLocation?: string
    salt?: string | null
}

// Namespace re-exports matching SDK structure
export const types = {
    GCREdit: {} as GCREdit,
    GCREditStorageProgram: {} as GCREditStorageProgram,
}

export const storage = {
    StorageProgramPayload: {} as StorageProgramPayload,
}
