/**
 * Configuration loader.
 *
 * Reads process.env ONCE at startup and returns a deeply-frozen AppConfig.
 * All parsing, defaults, and validation happen here — nowhere else.
 */

import * as dotenv from "dotenv"
import { EnvKey } from "./envKeys"
import { DEFAULT_CONFIG } from "./defaults"
import type { AppConfig } from "./types"

// Ensure .env is loaded before reading any env vars.
// This must happen here (not in index.ts) because ES module imports
// are hoisted — transitive imports like datasource.ts may call
// Config.getInstance() before index.ts module-level code runs.
dotenv.config()

// --- Parsing helpers ---

function envStr(key: string, fallback: string): string {
    const raw = process.env[key]
    if (raw === undefined || raw === "") return fallback
    return raw
}

function envInt(key: string, fallback: number): number {
    const raw = process.env[key]
    if (raw === undefined || raw === "") return fallback
    const parsed = Number.parseInt(raw, 10)
    return Number.isNaN(parsed) ? fallback : parsed
}

function envFloat(key: string, fallback: number): number {
    const raw = process.env[key]
    if (raw === undefined || raw === "") return fallback
    const parsed = Number.parseFloat(raw)
    return Number.isNaN(parsed) ? fallback : parsed
}

function envBool(key: string, fallback: boolean): boolean {
    const raw = process.env[key]
    if (raw === undefined || raw === "") return fallback
    return raw === "true" || raw === "1"
}

function envList(key: string, fallback: string[] = []): string[] {
    const raw = process.env[key]
    if (!raw) return fallback
    return raw.split(",").map(s => s.trim()).filter(s => s.length > 0)
}

// --- Deep freeze utility ---

function deepFreeze<T extends object>(obj: T): Readonly<T> {
    for (const value of Object.values(obj)) {
        if (value && typeof value === "object" && !Object.isFrozen(value)) {
            deepFreeze(value as object)
        }
    }
    return Object.freeze(obj)
}

// --- Main loader ---

export function loadConfig(): Readonly<AppConfig> {
    const d = DEFAULT_CONFIG

    const serverPort = envInt(EnvKey.SERVER_PORT, d.server.serverPort)
    const serverConfig = {
        serverPort,
        rpcPort: envInt(EnvKey.RPC_PORT, d.server.rpcPort),
        rpcPgPort: envInt(EnvKey.RPC_PG_PORT, d.server.rpcPgPort),
        signalingServerPort: envInt(EnvKey.SIGNALING_SERVER_PORT, d.server.signalingServerPort),
        rpcSignalingPort: envInt(EnvKey.RPC_SIGNALING_PORT, d.server.rpcSignalingPort),
        mcpServerPort: envInt(EnvKey.MCP_SERVER_PORT, d.server.mcpServerPort),
        rpcMcpPort: envInt(EnvKey.RPC_MCP_PORT, d.server.rpcMcpPort),
        omniPort: envInt(EnvKey.OMNI_PORT, d.server.omniPort),
    }

    const config: AppConfig = {
        server: serverConfig,
        database: {
            host: envStr(EnvKey.PG_HOST, d.database.host),
            port: envInt(EnvKey.PG_PORT, d.database.port),
            user: envStr(EnvKey.PG_USER, d.database.user),
            password: envStr(EnvKey.PG_PASSWORD, d.database.password),
            database: envStr(EnvKey.PG_DATABASE, d.database.database),
        },

        core: {
            prod: envBool(EnvKey.PROD, d.core.prod),
            shardSize: envInt(EnvKey.SHARD_SIZE, d.core.shardSize),
            mainLoopSleepTime: envInt(EnvKey.MAIN_LOOP_SLEEP_TIME, d.core.mainLoopSleepTime),
            rpcFeePercent: envInt(EnvKey.RPC_FEE_PERCENT, d.core.rpcFeePercent),
            rpcFee: envInt(EnvKey.RPC_FEE, d.core.rpcFee),
            identityFile: envStr(EnvKey.IDENTITY_FILE, d.core.identityFile),
            peerListFile: envStr(EnvKey.PEER_LIST_FILE, d.core.peerListFile),
            exposedUrl: envStr(EnvKey.EXPOSED_URL, d.core.exposedUrl) || `http://localhost:${serverPort}`,
            sudoPubkey: envStr(EnvKey.SUDO_PUBKEY, "") || null,
            maxMessageSize: envInt(EnvKey.MAX_MESSAGE_SIZE, d.core.maxMessageSize),
            consensusCheckInterval: envInt(EnvKey.CONSENSUS_CHECK_INTERVAL, d.core.consensusCheckInterval),
            consensusTime: envInt(EnvKey.CONSENSUS_TIME, d.core.consensusTime),
            logLevel: envStr(EnvKey.LOG_LEVEL, d.core.logLevel),
            whitelistedIPs: envList(EnvKey.WHITELISTED_IPS, d.core.whitelistedIPs),
            whitelistedKeys: envList(EnvKey.WHITELISTED_KEYS, d.core.whitelistedKeys),
            mcpEnabled: envBool(EnvKey.MCP_ENABLED, d.core.mcpEnabled),
            restore: envBool(EnvKey.RESTORE, d.core.restore),
        },

        tlsnotary: {
            enabled: envBool(EnvKey.TLSNOTARY_ENABLED, d.tlsnotary.enabled),
            host: envStr(EnvKey.TLSNOTARY_HOST, d.tlsnotary.host),
            port: envInt(EnvKey.TLSNOTARY_PORT, d.tlsnotary.port),
            signingKey: envStr(EnvKey.TLSNOTARY_SIGNING_KEY, d.tlsnotary.signingKey),
            fatal: envBool(EnvKey.TLSNOTARY_FATAL, d.tlsnotary.fatal),
            debug: envBool(EnvKey.TLSNOTARY_DEBUG, d.tlsnotary.debug),
            proxy: envBool(EnvKey.TLSNOTARY_PROXY, d.tlsnotary.proxy),
            disabled: envBool(EnvKey.TLSNOTARY_DISABLED, d.tlsnotary.disabled),
            mode: envStr(EnvKey.TLSNOTARY_MODE, d.tlsnotary.mode),
            maxSentData: envInt(EnvKey.TLSNOTARY_MAX_SENT_DATA, d.tlsnotary.maxSentData),
            maxRecvData: envInt(EnvKey.TLSNOTARY_MAX_RECV_DATA, d.tlsnotary.maxRecvData),
            autoStart: envBool(EnvKey.TLSNOTARY_AUTO_START, d.tlsnotary.autoStart),
            proxyPort: envInt(EnvKey.TLSNOTARY_PROXY_PORT, d.tlsnotary.proxyPort),
        },

        omni: {
            enabled: envBool(EnvKey.OMNI_ENABLED, d.omni.enabled),
            port: envInt(EnvKey.OMNI_PORT, d.omni.port) || serverConfig.rpcPort + 1,
            fatal: envBool(EnvKey.OMNI_FATAL, d.omni.fatal),
            mode: envStr(EnvKey.OMNI_MODE, d.omni.mode),
            tls: {
                enabled: envBool(EnvKey.OMNI_TLS_ENABLED, d.omni.tls.enabled),
                mode: envStr(EnvKey.OMNI_TLS_MODE, d.omni.tls.mode),
                certPath: envStr(EnvKey.OMNI_CERT_PATH, d.omni.tls.certPath),
                keyPath: envStr(EnvKey.OMNI_KEY_PATH, d.omni.tls.keyPath),
                caPath: envStr(EnvKey.OMNI_CA_PATH, d.omni.tls.caPath),
                minVersion: envStr(EnvKey.OMNI_TLS_MIN_VERSION, d.omni.tls.minVersion),
            },
            rateLimit: {
                enabled: envBool(EnvKey.OMNI_RATE_LIMIT_ENABLED, d.omni.rateLimit.enabled),
                maxConnectionsPerIp: envInt(EnvKey.OMNI_MAX_CONNECTIONS_PER_IP, d.omni.rateLimit.maxConnectionsPerIp),
                maxRequestsPerSecondPerIp: envInt(EnvKey.OMNI_MAX_REQUESTS_PER_SECOND_PER_IP, d.omni.rateLimit.maxRequestsPerSecondPerIp),
                maxRequestsPerSecondPerIdentity: envInt(EnvKey.OMNI_MAX_REQUESTS_PER_SECOND_PER_IDENTITY, d.omni.rateLimit.maxRequestsPerSecondPerIdentity),
            },
        },

        l2ps: {
            zkEnabled: envBool(EnvKey.L2PS_ZK_ENABLED, d.l2ps.zkEnabled),
            zkUseMainThread: envBool(EnvKey.L2PS_ZK_USE_MAIN_THREAD, d.l2ps.zkUseMainThread),
            hashIntervalMs: envInt(EnvKey.L2PS_HASH_INTERVAL_MS, d.l2ps.hashIntervalMs),
            aggregationIntervalMs: envInt(EnvKey.L2PS_AGGREGATION_INTERVAL_MS, d.l2ps.aggregationIntervalMs),
            minBatchSize: envInt(EnvKey.L2PS_MIN_BATCH_SIZE, d.l2ps.minBatchSize),
            maxBatchSize: envInt(EnvKey.L2PS_MAX_BATCH_SIZE, d.l2ps.maxBatchSize),
            cleanupAgeMs: envInt(EnvKey.L2PS_CLEANUP_AGE_MS, d.l2ps.cleanupAgeMs),
        },

        metrics: {
            enabled: envBool(EnvKey.METRICS_ENABLED, d.metrics.enabled),
            port: envInt(EnvKey.METRICS_PORT, d.metrics.port),
            host: envStr(EnvKey.METRICS_HOST, d.metrics.host),
        },

        diagnostics: {
            minCpuSpeed: envFloat(EnvKey.MIN_CPU_SPEED, d.diagnostics.minCpuSpeed),
            minRam: envFloat(EnvKey.MIN_RAM, d.diagnostics.minRam),
            minDiskSpace: envFloat(EnvKey.MIN_DISK_SPACE, d.diagnostics.minDiskSpace),
            minNetworkDownloadSpeed: envFloat(EnvKey.MIN_NETWORK_DOWNLOAD_SPEED, d.diagnostics.minNetworkDownloadSpeed),
            minNetworkUploadSpeed: envFloat(EnvKey.MIN_NETWORK_UPLOAD_SPEED, d.diagnostics.minNetworkUploadSpeed),
            networkTestFileSize: envFloat(EnvKey.NETWORK_TEST_FILE_SIZE, d.diagnostics.networkTestFileSize),
            suggestedCpuSpeed: envFloat(EnvKey.SUGGESTED_CPU_SPEED, d.diagnostics.suggestedCpuSpeed)
                || envFloat(EnvKey.MIN_CPU_SPEED, d.diagnostics.suggestedCpuSpeed),
            suggestedRam: envFloat(EnvKey.SUGGESTED_RAM, d.diagnostics.suggestedRam)
                || envFloat(EnvKey.MIN_RAM, d.diagnostics.suggestedRam),
            suggestedDiskSpace: envFloat(EnvKey.SUGGESTED_DISK_SPACE, d.diagnostics.suggestedDiskSpace)
                || envFloat(EnvKey.MIN_DISK_SPACE, d.diagnostics.suggestedDiskSpace),
            suggestedNetworkDownloadSpeed: envFloat(EnvKey.SUGGESTED_NETWORK_DOWNLOAD_SPEED, d.diagnostics.suggestedNetworkDownloadSpeed)
                || envFloat(EnvKey.MIN_NETWORK_DOWNLOAD_SPEED, d.diagnostics.suggestedNetworkDownloadSpeed),
            suggestedNetworkUploadSpeed: envFloat(EnvKey.SUGGESTED_NETWORK_UPLOAD_SPEED, d.diagnostics.suggestedNetworkUploadSpeed)
                || envFloat(EnvKey.MIN_NETWORK_UPLOAD_SPEED, d.diagnostics.suggestedNetworkUploadSpeed),
        },

        identity: {
            githubToken: envStr(EnvKey.GITHUB_TOKEN, d.identity.githubToken),
            discordApiUrl: envStr(EnvKey.DISCORD_API_URL, d.identity.discordApiUrl),
            discordBotToken: envStr(EnvKey.DISCORD_BOT_TOKEN, d.identity.discordBotToken),
            humanPassportApiUrl: envStr(EnvKey.HUMAN_PASSPORT_API_URL, d.identity.humanPassportApiUrl),
            humanPassportScorerId: envStr(EnvKey.HUMAN_PASSPORT_SCORER_ID, d.identity.humanPassportScorerId),
            humanPassportApiKey: envStr(EnvKey.HUMAN_PASSPORT_API_KEY, d.identity.humanPassportApiKey),
            nomisApiBaseUrl: envStr(EnvKey.NOMIS_API_BASE_URL, d.identity.nomisApiBaseUrl),
            nomisDefaultScoreType: envInt(EnvKey.NOMIS_DEFAULT_SCORE_TYPE, d.identity.nomisDefaultScoreType),
            nomisDefaultDeadlineOffsetSeconds: envInt(EnvKey.NOMIS_DEFAULT_DEADLINE_OFFSET_SECONDS, d.identity.nomisDefaultDeadlineOffsetSeconds),
            nomisApiKey: envStr(EnvKey.NOMIS_API_KEY, d.identity.nomisApiKey),
            nomisClientId: envStr(EnvKey.NOMIS_CLIENT_ID, d.identity.nomisClientId),
            nomisApiTimeoutMs: envInt(EnvKey.NOMIS_API_TIMEOUT_MS, d.identity.nomisApiTimeoutMs),
            etherscanApiKey: envStr(EnvKey.ETHERSCAN_API_KEY, d.identity.etherscanApiKey),
            heliusApiKey: envStr(EnvKey.HELIUS_API_KEY, d.identity.heliusApiKey),
            rapidApiKey: envStr(EnvKey.RAPID_API_KEY, d.identity.rapidApiKey),
            rapidApiHost: envStr(EnvKey.RAPID_API_HOST, d.identity.rapidApiHost),
            solanaRpc: envStr(EnvKey.SOLANA_RPC, d.identity.solanaRpc),
            zkAttestationPoints: envInt(EnvKey.ZK_ATTESTATION_POINTS, d.identity.zkAttestationPoints),
        },

        bridges: {
            rubicApiReferrerAddress: envStr(EnvKey.RUBIC_API_REFERRER_ADDRESS, d.bridges.rubicApiReferrerAddress),
            rubicApiIntegratorAddress: envStr(EnvKey.RUBIC_API_INTEGRATOR_ADDRESS, d.bridges.rubicApiIntegratorAddress),
        },

        ipfs: {
            swarmPort: envInt(EnvKey.IPFS_SWARM_PORT, d.ipfs.swarmPort),
            apiPort: envInt(EnvKey.IPFS_API_PORT, d.ipfs.apiPort),
        },
    }

    return deepFreeze(config)
}
