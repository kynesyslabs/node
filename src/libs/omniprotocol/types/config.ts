import {
    DEFAULT_POOL_MAX_TOTAL_CONNECTIONS,
    DEFAULT_POOL_MAX_CONNECTIONS_PER_PEER,
    DEFAULT_POOL_IDLE_TIMEOUT_MS,
    DEFAULT_POOL_CONNECT_TIMEOUT_MS,
    DEFAULT_POOL_AUTH_TIMEOUT_MS,
    DEFAULT_MAX_CONCURRENT_REQUESTS,
    DEFAULT_MAX_TOTAL_CONCURRENT_REQUESTS,
    DEFAULT_CIRCUIT_BREAKER_THRESHOLD,
    DEFAULT_CIRCUIT_BREAKER_TIMEOUT_MS,
    DEFAULT_MIGRATION_FALLBACK_TIMEOUT_MS,
    OMNI_PROTOCOL_VERSION,
    DEFAULT_PROTOCOL_TIMEOUT_MS,
    DEFAULT_PROTOCOL_LONG_CALL_TIMEOUT_MS,
    DEFAULT_MAX_PAYLOAD_SIZE,
} from "../constants"

export type MigrationMode = "HTTP_ONLY" | "OMNI_PREFERRED" | "OMNI_ONLY"

export interface ConnectionPoolConfig {
    maxTotalConnections: number // Wave 8.1: Maximum total TCP connections across all peers
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
        maxTotalConnections: DEFAULT_POOL_MAX_TOTAL_CONNECTIONS,
        maxConnectionsPerPeer: DEFAULT_POOL_MAX_CONNECTIONS_PER_PEER,
        idleTimeout: DEFAULT_POOL_IDLE_TIMEOUT_MS,
        connectTimeout: DEFAULT_POOL_CONNECT_TIMEOUT_MS,
        authTimeout: DEFAULT_POOL_AUTH_TIMEOUT_MS,
        maxConcurrentRequests: DEFAULT_MAX_CONCURRENT_REQUESTS,
        maxTotalConcurrentRequests: DEFAULT_MAX_TOTAL_CONCURRENT_REQUESTS,
        circuitBreakerThreshold: DEFAULT_CIRCUIT_BREAKER_THRESHOLD,
        circuitBreakerTimeout: DEFAULT_CIRCUIT_BREAKER_TIMEOUT_MS,
    },
    migration: {
        mode: "HTTP_ONLY",
        omniPeers: new Set<string>(),
        autoDetect: true,
        fallbackTimeout: DEFAULT_MIGRATION_FALLBACK_TIMEOUT_MS,
    },
    protocol: {
        version: OMNI_PROTOCOL_VERSION,
        defaultTimeout: DEFAULT_PROTOCOL_TIMEOUT_MS,
        longCallTimeout: DEFAULT_PROTOCOL_LONG_CALL_TIMEOUT_MS,
        maxPayloadSize: DEFAULT_MAX_PAYLOAD_SIZE,
    },
}
