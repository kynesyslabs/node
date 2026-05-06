/**
 * Default configuration values.
 *
 * These are used when the corresponding environment variable is not set.
 * Grouped by AppConfig section.
 */

import type { AppConfig } from "./types"

export const DEFAULT_CONFIG: AppConfig = {
    server: {
        serverPort: 53550,
        rpcPort: 0,
        rpcPgPort: 5332,
        signalingServerPort: 3005,
        rpcSignalingPort: 0,
        mcpServerPort: 3001,
        rpcMcpPort: 0,
        omniPort: 0, // calculated as serverPort + 1 if 0
    },

    database: {
        host: "localhost",
        port: 5332,
        user: "demosuser",
        password: "demospassword",
        database: "demos",
    },

    core: {
        prod: false,
        shardSize: 4,
        mainLoopSleepTime: 1000,
        rpcFeePercent: 10,
        // Flat per-tx fee components. Total cost of a tx today is the sum
        // of these three: networkFee + rpcFee + burnFee = 1 + 1 + 1 = 3.
        // No congestion adjustment — see calculateCurrentGas.ts for the
        // (currently stubbed) dynamic-pricing seam.
        // TODO(decimals): once OS denomination ships, the three components
        // must add up to exactly 1 DEM (≈ 333_333_333 OS each, exact split
        // TBD). See `decimal_planning/SPEC.md` / Mycelium E#3.
        rpcFee: 1,
        networkFee: 1,
        burnFee: 1,
        minValidatorStake: "1000000000000000000",
        identityFile: ".demos_identity",
        peerListFile: "demos_peerlist.json",
        exposedUrl: "",  // calculated from serverPort if empty
        sudoPubkey: null,
        maxMessageSize: 0,
        consensusCheckInterval: 0,
        consensusTime: 0,
        logLevel: "info",
        whitelistedIPs: [],
        whitelistedKeys: [],
        mcpEnabled: true,
        restore: false,
    },

    tlsnotary: {
        enabled: false,
        host: "localhost",
        port: 7047,
        signingKey: "",
        fatal: false,
        debug: false,
        proxy: false,
        disabled: false,
        mode: "docker",
        maxSentData: 16384,
        maxRecvData: 65536,
        autoStart: true,
        proxyPort: 55688,
    },

    omni: {
        enabled: true,
        port: 0, // uses NODE_PORT or PORT fallback
        fatal: false,
        mode: "",
        tls: {
            enabled: false,
            mode: "self-signed",
            certPath: "./certs/node-cert.pem",
            keyPath: "./certs/node-key.pem",
            caPath: "",
            minVersion: "",
        },
        rateLimit: {
            enabled: true,
            maxConnectionsPerIp: 10,
            maxRequestsPerSecondPerIp: 0,
            maxRequestsPerSecondPerIdentity: 0,
        },
    },

    l2ps: {
        zkEnabled: true,
        zkUseMainThread: false,
        hashIntervalMs: 5000,
        aggregationIntervalMs: 10000,
        minBatchSize: 1,
        maxBatchSize: 10,
        cleanupAgeMs: 300000,
    },

    metrics: {
        enabled: true,
        port: 9090,
        host: "0.0.0.0",
    },

    diagnostics: {
        minCpuSpeed: 0,
        minRam: 0,
        minDiskSpace: 0,
        minNetworkDownloadSpeed: 0,
        minNetworkUploadSpeed: 0,
        networkTestFileSize: 0,
        suggestedCpuSpeed: 0,
        suggestedRam: 0,
        suggestedDiskSpace: 0,
        suggestedNetworkDownloadSpeed: 0,
        suggestedNetworkUploadSpeed: 0,
    },

    identity: {
        githubToken: "",
        discordApiUrl: "https://discord.com/api/v10",
        discordBotToken: "",
        humanPassportApiUrl: "https://api.passport.xyz",
        humanPassportScorerId: "",
        humanPassportApiKey: "",
        nomisApiBaseUrl: "https://api.nomis.cc",
        nomisDefaultScoreType: 0,
        nomisDefaultDeadlineOffsetSeconds: 3600,
        nomisApiKey: "",
        nomisClientId: "",
        nomisApiTimeoutMs: 10000,
        etherscanApiKey: "",
        heliusApiKey: "",
        rapidApiKey: "",
        rapidApiHost: "",
        solanaRpc: "",
        zkAttestationPoints: 10,
    },

    bridges: {
        rubicApiReferrerAddress: "rubic.exchange",
        rubicApiIntegratorAddress: "",
    },

    ipfs: {
        swarmPort: 4001,
        apiPort: 5001,
    },
}
