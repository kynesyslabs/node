import type {
    Web2GCRData,
    XmGCRIdentityData,
    XMCoreTargetIdentityPayload,
    PQCIdentityGCREditData,
    PqcIdentityRemovePayload,
    UdGCRData,
} from "@kynesyslabs/demosdk/build/types/blockchain/GCREdit"

declare module "@kynesyslabs/demosdk/build/types/blockchain/GCREdit" {
    export interface NomisIdentityGCREditData {
        chain: string
        subchain: string
        address: string
        score: number
        scoreType: number
        mintedScore?: number | null
        lastSyncedAt: string
        metadata?: Record<string, unknown>
    }

  export interface EthosIdentityGCREditData {
    chain: string
    subchain: string
    address: string
    score: number
    profileId?: number
    lastSyncedAt: string
    metadata?: {
      displayName?: string
      username?: string
      [key: string]: unknown
    }
  }

    export interface GCREditIdentity {
        context: "xm" | "web2" | "pqc" | "ud" | "nomis" | "ethos"
        data:
          | Web2GCRData
          | XmGCRIdentityData
          | XMCoreTargetIdentityPayload
          | PQCIdentityGCREditData[]
          | PqcIdentityRemovePayload["payload"]
          | UdGCRData
          | NomisIdentityGCREditData
          | EthosIdentityGCREditData
  }
}
