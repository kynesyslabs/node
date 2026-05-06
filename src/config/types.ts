/**
 * Configuration type definitions.
 * Each section maps to a domain/subsystem of the node.
 */

// --- Server & Ports ---

export interface ServerConfig {
    serverPort: number
    rpcPort: number
    rpcPgPort: number
    signalingServerPort: number
    rpcSignalingPort: number
    mcpServerPort: number
    rpcMcpPort: number
    omniPort: number
}

// --- Database (PostgreSQL) ---

export interface DatabaseConfig {
    host: string
    port: number
    user: string
    password: string
    database: string
}

// --- Core Node ---

export interface CoreConfig {
    prod: boolean
    shardSize: number
    mainLoopSleepTime: number
    rpcFeePercent: number
    identityFile: string
    peerListFile: string
    exposedUrl: string
    sudoPubkey: string | null
    maxMessageSize: number
    consensusCheckInterval: number
    consensusTime: number
    logLevel: string
    whitelistedIPs: string[]
    whitelistedKeys: string[]
    mcpEnabled: boolean
    restore: boolean
    rpcFee: number
    networkFee: number
    /** Per-tx burn — sat/lamport-style integer for now.
     *  TODO(decimals): once OS denomination lands, networkFee + rpcFee +
     *  burnFee must sum to 1 DEM (≈ 333_333_333 OS each, exact split TBD).
     *  See `decimal_planning/SPEC.md` and Mycelium epic E#3. */
    burnFee: number
    minValidatorStake: string
}

// --- TLSNotary ---

export interface TLSNotaryConfig {
    enabled: boolean
    host: string
    port: number
    signingKey: string
    fatal: boolean
    debug: boolean
    proxy: boolean
    disabled: boolean
    mode: string
    maxSentData: number
    maxRecvData: number
    autoStart: boolean
    proxyPort: number
}

// --- OmniProtocol ---

export interface OmniConfig {
    enabled: boolean
    port: number
    fatal: boolean
    mode: string
    tls: {
        enabled: boolean
        mode: string
        certPath: string
        keyPath: string
        caPath: string
        minVersion: string
    }
    rateLimit: {
        enabled: boolean
        maxConnectionsPerIp: number
        maxRequestsPerSecondPerIp: number
        maxRequestsPerSecondPerIdentity: number
    }
}

// --- L2PS (Layer 2 Proof System) ---

export interface L2PSConfig {
    zkEnabled: boolean
    zkUseMainThread: boolean
    hashIntervalMs: number
    aggregationIntervalMs: number
    minBatchSize: number
    maxBatchSize: number
    cleanupAgeMs: number
}

// --- Metrics & Monitoring ---

export interface MetricsConfig {
    enabled: boolean
    port: number
    host: string
}

// --- System Diagnostics ---

export interface DiagnosticsConfig {
    minCpuSpeed: number
    minRam: number
    minDiskSpace: number
    minNetworkDownloadSpeed: number
    minNetworkUploadSpeed: number
    networkTestFileSize: number
    suggestedCpuSpeed: number
    suggestedRam: number
    suggestedDiskSpace: number
    suggestedNetworkDownloadSpeed: number
    suggestedNetworkUploadSpeed: number
}

// --- Identity & Web2 Services ---

export interface IdentityConfig {
    githubToken: string
    discordApiUrl: string
    discordBotToken: string
    humanPassportApiUrl: string
    humanPassportScorerId: string
    humanPassportApiKey: string
    nomisApiBaseUrl: string
    nomisDefaultScoreType: number
    nomisDefaultDeadlineOffsetSeconds: number
    nomisApiKey: string
    nomisClientId: string
    nomisApiTimeoutMs: number
    etherscanApiKey: string
    heliusApiKey: string
    rapidApiKey: string
    rapidApiHost: string
    solanaRpc: string
    zkAttestationPoints: number
}

// --- Bridges ---

export interface BridgesConfig {
    rubicApiReferrerAddress: string
    rubicApiIntegratorAddress: string
}

// --- IPFS ---

export interface IPFSConfig {
    swarmPort: number
    apiPort: number
}

// --- Full Application Config ---

export interface AppConfig {
    server: ServerConfig
    database: DatabaseConfig
    core: CoreConfig
    tlsnotary: TLSNotaryConfig
    omni: OmniConfig
    l2ps: L2PSConfig
    metrics: MetricsConfig
    diagnostics: DiagnosticsConfig
    identity: IdentityConfig
    bridges: BridgesConfig
    ipfs: IPFSConfig
}
