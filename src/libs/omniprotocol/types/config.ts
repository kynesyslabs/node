export type MigrationMode = "HTTP_ONLY" | "OMNI_PREFERRED" | "OMNI_ONLY"

export interface ConnectionPoolConfig {
    maxConnectionsPerPeer: number
    idleTimeout: number
    connectTimeout: number
    authTimeout: number
    maxConcurrentRequests: number
    maxTotalConcurrentRequests: number
    circuitBreakerThreshold: number
    circuitBreakerTimeout: number
}

export interface ProtocolRuntimeConfig {
    version: number
    defaultTimeout: number
    longCallTimeout: number
    maxPayloadSize: number
}

export interface MigrationConfig {
    mode: MigrationMode
    omniPeers: Set<string>
    autoDetect: boolean
    fallbackTimeout: number
}

export interface OmniProtocolConfig {
    pool: ConnectionPoolConfig
    migration: MigrationConfig
    protocol: ProtocolRuntimeConfig
}

export const DEFAULT_OMNIPROTOCOL_CONFIG: OmniProtocolConfig = {
    pool: {
        maxConnectionsPerPeer: 1,
        idleTimeout: 10 * 60 * 1000,
        connectTimeout: 5_000,
        authTimeout: 5_000,
        maxConcurrentRequests: 100,
        maxTotalConcurrentRequests: 1_000,
        circuitBreakerThreshold: 5,
        circuitBreakerTimeout: 30_000,
    },
    migration: {
        mode: "HTTP_ONLY",
        omniPeers: new Set<string>(),
        autoDetect: true,
        fallbackTimeout: 1_000,
    },
    protocol: {
        version: 0x01,
        defaultTimeout: 3_000,
        longCallTimeout: 10_000,
        maxPayloadSize: 10 * 1024 * 1024,
    },
}
