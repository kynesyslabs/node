/**
 * Default configuration values.
 *
 * These are used when the corresponding environment variable is not set.
 * Grouped by AppConfig section.
 */

import type { AppConfig } from "./types"
import { demToOs } from "@kynesyslabs/demosdk/utils"
import { RATE_LIMIT_DEFAULT_BLOCK_DURATION_MS } from "../utilities/constants"

export const DEFAULT_CONFIG: AppConfig = {
    server: {
        serverPort: 53550,
        rpcPort: 0,
        // 0.0.0.0 keeps the docker bridge working; a validator behind a
        // proxy narrows it to loopback or its private interface.
        rpcBind: "0.0.0.0",
        // Covers the largest single legitimate request: a block or a
        // storage-program write (1 MiB of data, repeated inside the signed
        // body and its edits) with JSON overhead.
        rpcMaxBodyBytes: 4 * 1024 * 1024,
        // The consensus mempool merge ships a whole mempool in one request,
        // and the mempool is capped at 32 MiB, so peers get twice that.
        rpcPeerMaxBodyBytes: 64 * 1024 * 1024,
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
        connectTimeoutMs: 10_000,
        statementTimeoutMs: 10_000,
        queryTimeoutMs: 10_000,
        lockTimeoutMs: 20_000,
        idleTransactionTimeoutMs: 20_000,
    },

    core: {
        prod: false,
        mainLoopSleepTime: 1000,
        helloRefreshIntervalMs: 5000,
        rpcFeePercent: 10,
        // Flat per-tx fee components. Total cost of a tx today is the sum
        // of these three: networkFee + rpcFee + burnFee = 1 + 1 + 1 = 3.
        // No congestion adjustment — see calculateCurrentGas.ts for the
        // (currently stubbed) dynamic-pricing seam.
        // TODO(decimals): once OS denomination ships, the three components
        // must add up to exactly 1 DEM (≈ 333_333_333 OS each, exact split
        // TBD). See `forking/decimal_planning/SPEC.md` / Mycelium E#3.
        rpcFee: 1,
        networkFee: 1,
        burnFee: 1,
        minValidatorStake: demToOs(1000).toString(),
        identityFile: ".demos_identity",
        peerListFile: "demos_peerlist.json",
        exposedUrl: "", // calculated from serverPort if empty
        sudoPubkey: null,
        maxMessageSize: 0,
        consensusCheckInterval: 0,
        consensusTime: 0,
        blockTimestampMinDelta: 1,
        blockTimestampTolerance: 60,
        logLevel: "info",
        whitelistedIPs: [],
        whitelistedKeys: [],
        trustedProxies: [],
        xffMode: "",
        rateLimitBlockDurationMs: RATE_LIMIT_DEFAULT_BLOCK_DURATION_MS,
        // MCP server (Model Context Protocol) is OFF by default. It currently
        // has no built-in authentication and exposes node identity + peer
        // topology via its `get_node_identity` / `get_peer_list` tools.
        // Opt-in via MCP_ENABLED=true after reading docs/runbooks/mcp-security.md.
        // See docs/discoveries/startup-assessment-2026-05-13/08-epic-3-blockers.md.
        mcpEnabled: false,
        restore: false,
        expectedGenesisHash: "",
        blockWatchdogEnabled: false,
        blockWatchdogTimeoutSeconds: 600,
        stallDetectionBlocks: 3,
        forkScheduleMismatchPolicy: "abstain",
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
        mempoolMaxExecutedPerSubnet: 50_000,
        aggregatorMaxBatchesPerCycle: 5,
        messagingSendRate: 5,
        messagingSendBurst: 30,
        messagingBacklogShare: 0.5,
        historyRetentionDays: 0,
        historyStorePlaintext: false,
        historyRequireV2: false,
    },

    metrics: {
        enabled: true,
        port: 9090,
        // Loopback by default: /metrics has no authentication. Compose pins
        // METRICS_HOST=0.0.0.0 inside the container and controls host
        // exposure with METRICS_BIND; bare-metal operators opt in explicitly.
        host: "127.0.0.1",
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

    debug: {
        assertionsEnabled: false,
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

    gossip: {
        enabled: true,
        port: 9095,
        heightsIntervalMs: 1000,
        keyFile: ".demos_gossip_key",
    },
}
