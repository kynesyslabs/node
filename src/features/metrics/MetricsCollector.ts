/**
 * MetricsCollector - Active metrics collection from node state
 *
 * Collects live metrics from various node subsystems and updates
 * the MetricsService gauges/counters periodically.
 *
 * @module features/metrics
 */

import os from "node:os"
import { exec } from "node:child_process"
import { promisify } from "node:util"
import { MetricsService } from "./MetricsService"
import log from "@/utilities/logger"
import { Config } from "src/config"
import type { MetricsCollectorConfig } from "./types"
import {
    DEFAULT_COLLECTOR_CONFIG,
    HTTP_HEALTH_CHECK_TIMEOUT_MS,
    MAX_PEERS_TO_REPORT,
} from "./constants"

// Re-export for backward compatibility
export type { MetricsCollectorConfig } from "./types"

const execAsync = promisify(exec)

/**
 * MetricsCollector - Actively collects metrics from node subsystems
 *
 * This service runs on a timer and updates the MetricsService
 * with current values from the blockchain, network, and system.
 */
export class MetricsCollector {
    private static instance: MetricsCollector | null = null
    private metricsService: MetricsService
    private config: MetricsCollectorConfig
    private collectionInterval: Timer | null = null
    private running = false

    // CPU usage tracking
    private lastCpuInfo: { user: number; system: number; idle: number } | null =
        null
    private lastCpuTime = 0

    // Network I/O tracking
    private lastNetworkStats: Map<string, { rx: number; tx: number }> =
        new Map()
    private lastNetworkTime = 0

    private constructor(config?: Partial<MetricsCollectorConfig>) {
        this.config = { ...DEFAULT_COLLECTOR_CONFIG, ...config }
        this.metricsService = MetricsService.getInstance()
    }

    public static getInstance(
        config?: Partial<MetricsCollectorConfig>,
    ): MetricsCollector {
        if (!MetricsCollector.instance) {
            MetricsCollector.instance = new MetricsCollector(config)
        }
        return MetricsCollector.instance
    }

    /**
     * Start the metrics collection loop
     */
    public async start(): Promise<void> {
        if (this.running) {
            log.warning("[METRICS COLLECTOR] Already running")
            return
        }

        if (!this.config.enabled) {
            log.info("[METRICS COLLECTOR] Collection disabled")
            return
        }

        log.info(
            `[METRICS COLLECTOR] Starting with ${this.config.collectionIntervalMs}ms interval`,
        )

        // Register additional metrics
        this.registerAdditionalMetrics()

        // Initial collection
        await this.collectAll()

        // Start periodic collection
        this.collectionInterval = setInterval(
            async () => {
                await this.collectAll()
            },
            this.config.collectionIntervalMs,
        )

        this.running = true
        log.info("[METRICS COLLECTOR] Started")
    }

    /**
     * Stop the metrics collection loop
     */
    public stop(): void {
        if (this.collectionInterval) {
            clearInterval(this.collectionInterval)
            this.collectionInterval = null
        }
        this.running = false
        log.info("[METRICS COLLECTOR] Stopped")
    }

    /**
     * Register additional metrics that are not in the core set
     */
    private registerAdditionalMetrics(): void {
        const ms = this.metricsService

        // === Blockchain Extended Metrics ===
        ms.createGauge(
            "last_block_tx_count",
            "Number of transactions in the last block",
            [],
        )
        ms.createGauge(
            "seconds_since_last_block",
            "Seconds elapsed since the last block was produced",
            [],
        )
        ms.createGauge(
            "last_block_timestamp",
            "Unix timestamp of the last block",
            [],
        )

        // === System Metrics ===
        ms.createGauge("system_cpu_usage_percent", "CPU usage percentage", [])
        ms.createGauge(
            "system_memory_used_bytes",
            "Memory used in bytes",
            [],
        )
        ms.createGauge(
            "system_memory_total_bytes",
            "Total memory in bytes",
            [],
        )
        ms.createGauge(
            "system_memory_usage_percent",
            "Memory usage percentage",
            [],
        )
        ms.createGauge("system_load_average_1m", "1-minute load average", [])
        ms.createGauge("system_load_average_5m", "5-minute load average", [])
        ms.createGauge("system_load_average_15m", "15-minute load average", [])

        // === Network I/O Metrics ===
        ms.createGauge(
            "system_network_rx_bytes_total",
            "Total bytes received",
            ["interface"],
        )
        ms.createGauge(
            "system_network_tx_bytes_total",
            "Total bytes transmitted",
            ["interface"],
        )
        ms.createGauge(
            "system_network_rx_rate_bytes",
            "Bytes received per second",
            ["interface"],
        )
        ms.createGauge(
            "system_network_tx_rate_bytes",
            "Bytes transmitted per second",
            ["interface"],
        )

        // === Service Health Metrics ===
        ms.createGauge(
            "service_docker_container_up",
            "Docker container health (1=up, 0=down)",
            ["container"],
        )
        ms.createGauge(
            "service_port_open",
            "Port health check (1=open, 0=closed)",
            ["port", "service"],
        )

        // === Peer Metrics Extended ===
        ms.createGauge("peer_online_count", "Number of online peers", [])
        ms.createGauge("peer_offline_count", "Number of offline peers", [])
        ms.createGauge("peer_info", "Peer information", [
            "peer_id",
            "url",
            "status",
        ])

        // === Node Health Metrics (HTTP endpoint checks) ===
        ms.createGauge(
            "node_http_health",
            "Node HTTP endpoint health (1=responding, 0=not responding)",
            ["endpoint"],
        )
        ms.createGauge(
            "node_http_response_time_ms",
            "Node HTTP endpoint response time in milliseconds",
            ["endpoint"],
        )

        // === Node Metadata Metric (static labels with node metadata) ===
        ms.createGauge(
            "node_metadata",
            "Node metadata with version and identity labels",
            ["version", "version_name", "identity"],
        )

        log.debug("[METRICS COLLECTOR] Additional metrics registered")
    }

    /**
     * Collect all metrics
     */
    private async collectAll(): Promise<void> {
        try {
            await Promise.all([
                this.collectBlockchainMetrics(),
                this.collectSystemMetrics(),
                this.collectNetworkIOMetrics(),
                this.collectPeerMetrics(),
                this.collectNodeHttpHealth(),
                this.config.dockerHealthEnabled
                    ? this.collectDockerHealth()
                    : Promise.resolve(),
                this.config.portHealthEnabled
                    ? this.collectPortHealth()
                    : Promise.resolve(),
            ])
        } catch (error) {
            log.error(
                `[METRICS COLLECTOR] Collection error: ${error instanceof Error ? error.message : String(error)}`,
            )
        }
    }

    /**
     * Collect blockchain-related metrics
     */
    private async collectBlockchainMetrics(): Promise<void> {
        try {
            // Lazy import to avoid circular dependencies
            const chainModule = await import("@/libs/blockchain/chain")
            const { getSharedState } = await import("@/utilities/sharedState")

            const sharedState = getSharedState
            const chain = chainModule.default

            // Block height (already in core, but update it here too)
            this.metricsService.setGauge(
                "block_height",
                sharedState.lastBlockNumber,
            )

            // Get last block for detailed metrics
            const lastBlock = await chain.getLastBlock()
            if (lastBlock) {
                // Transaction count in last block
                const txCount = lastBlock.content?.ordered_transactions?.length ?? 0
                this.metricsService.setGauge("last_block_tx_count", txCount)

                // Block timestamp and time since last block
                const blockTimestamp = lastBlock.content?.timestamp ?? 0
                this.metricsService.setGauge(
                    "last_block_timestamp",
                    blockTimestamp,
                )

                // Only calculate time since block if we have a valid timestamp
                // Block timestamp is in SECONDS (Unix epoch), not milliseconds
                if (blockTimestamp > 0) {
                    const nowSeconds = Math.floor(Date.now() / 1000)
                    const secondsSinceBlock = Math.max(0, nowSeconds - blockTimestamp)
                    this.metricsService.setGauge(
                        "seconds_since_last_block",
                        secondsSinceBlock,
                    )
                } else {
                    // No valid timestamp - set to 0 (unknown)
                    this.metricsService.setGauge("seconds_since_last_block", 0)
                }
            }
        } catch (error) {
            log.debug(
                `[METRICS COLLECTOR] Blockchain metrics error: ${error instanceof Error ? error.message : String(error)}`,
            )
        }
    }

    /**
     * Collect system metrics (CPU, RAM)
     */
    private async collectSystemMetrics(): Promise<void> {
        try {
            // Memory metrics
            const totalMem = os.totalmem()
            const freeMem = os.freemem()
            const usedMem = totalMem - freeMem
            const memUsagePercent = (usedMem / totalMem) * 100

            this.metricsService.setGauge("system_memory_total_bytes", totalMem)
            this.metricsService.setGauge("system_memory_used_bytes", usedMem)
            this.metricsService.setGauge(
                "system_memory_usage_percent",
                memUsagePercent,
            )

            // Load average
            const loadAvg = os.loadavg()
            this.metricsService.setGauge("system_load_average_1m", loadAvg[0])
            this.metricsService.setGauge("system_load_average_5m", loadAvg[1])
            this.metricsService.setGauge("system_load_average_15m", loadAvg[2])

            // CPU usage calculation
            const cpuUsage = this.calculateCpuUsage()
            this.metricsService.setGauge("system_cpu_usage_percent", cpuUsage)
        } catch (error) {
            log.debug(
                `[METRICS COLLECTOR] System metrics error: ${error instanceof Error ? error.message : String(error)}`,
            )
        }
    }

    /**
     * Calculate CPU usage between collection intervals
     */
    private calculateCpuUsage(): number {
        const cpus = os.cpus()
        let totalUser = 0
        let totalSystem = 0
        let totalIdle = 0

        for (const cpu of cpus) {
            totalUser += cpu.times.user
            totalSystem += cpu.times.sys
            totalIdle += cpu.times.idle
        }

        const now = Date.now()

        if (this.lastCpuInfo && this.lastCpuTime) {
            const userDiff = totalUser - this.lastCpuInfo.user
            const systemDiff = totalSystem - this.lastCpuInfo.system
            const idleDiff = totalIdle - this.lastCpuInfo.idle
            const totalDiff = userDiff + systemDiff + idleDiff

            if (totalDiff > 0) {
                const usage = ((userDiff + systemDiff) / totalDiff) * 100
                this.lastCpuInfo = {
                    user: totalUser,
                    system: totalSystem,
                    idle: totalIdle,
                }
                this.lastCpuTime = now
                return Math.round(usage * 100) / 100
            }
        }

        this.lastCpuInfo = {
            user: totalUser,
            system: totalSystem,
            idle: totalIdle,
        }
        this.lastCpuTime = now
        return 0
    }

    /**
     * Report basic network interface metrics with zero values
     * Used as fallback when /proc/net/dev is unavailable (non-Linux or read error)
     */
    private reportBasicNetworkInterfaces(
        interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>,
    ): void {
        for (const [name] of Object.entries(interfaces)) {
            if (name !== "lo") {
                this.metricsService.setGauge("system_network_rx_bytes_total", 0, {
                    interface: name,
                })
                this.metricsService.setGauge("system_network_tx_bytes_total", 0, {
                    interface: name,
                })
            }
        }
    }

    /**
     * Collect network I/O metrics
     */
    private async collectNetworkIOMetrics(): Promise<void> {
        try {
            const interfaces = os.networkInterfaces()
            const now = Date.now()
            const timeDeltaSec = (now - this.lastNetworkTime) / 1000 || 1

            // On Linux, read from /proc/net/dev for accurate stats
            if (process.platform === "linux") {
                try {
                    const fs = await import("node:fs/promises")
                    const data = await fs.readFile("/proc/net/dev", "utf-8")
                    const lines = data.split("\n").slice(2) // Skip header lines

                    for (const line of lines) {
                        const parts = line.trim().split(/\s+/)
                        if (parts.length < 10) continue

                        const iface = parts[0].replace(":", "")
                        if (iface === "lo") continue // Skip loopback

                        const rxBytes = parseInt(parts[1], 10)
                        const txBytes = parseInt(parts[9], 10)

                        this.metricsService.setGauge(
                            "system_network_rx_bytes_total",
                            rxBytes,
                            { interface: iface },
                        )
                        this.metricsService.setGauge(
                            "system_network_tx_bytes_total",
                            txBytes,
                            { interface: iface },
                        )

                        // Calculate rates
                        const last = this.lastNetworkStats.get(iface)
                        if (last) {
                            const rxRate = (rxBytes - last.rx) / timeDeltaSec
                            const txRate = (txBytes - last.tx) / timeDeltaSec
                            this.metricsService.setGauge(
                                "system_network_rx_rate_bytes",
                                Math.max(0, rxRate),
                                { interface: iface },
                            )
                            this.metricsService.setGauge(
                                "system_network_tx_rate_bytes",
                                Math.max(0, txRate),
                                { interface: iface },
                            )
                        }

                        this.lastNetworkStats.set(iface, {
                            rx: rxBytes,
                            tx: txBytes,
                        })
                    }
                } catch {
                    // Fallback for Linux if /proc/net/dev fails
                    this.reportBasicNetworkInterfaces(interfaces)
                }
            } else {
                // Fallback for non-Linux platforms (macOS, Windows)
                // Report interface names with zero values to maintain metric consistency
                this.reportBasicNetworkInterfaces(interfaces)
            }

            this.lastNetworkTime = now
        } catch (error) {
            log.debug(
                `[METRICS COLLECTOR] Network I/O metrics error: ${error instanceof Error ? error.message : String(error)}`,
            )
        }
    }

    /**
     * Collect peer metrics
     */
    private async collectPeerMetrics(): Promise<void> {
        try {
            const peerModule = await import("@/libs/peer/PeerManager")
            const peerManager = peerModule.default.getInstance()

            // REVIEW: getOnlinePeers is async, getOfflinePeers returns Record<string, Peer>
            const onlinePeers = await peerManager.getOnlinePeers()
            const offlinePeersRecord = peerManager.getOfflinePeers()
            const offlinePeersCount = Object.keys(offlinePeersRecord).length
            const allPeers = peerManager.getAll()

            // Counts
            this.metricsService.setGauge("peer_online_count", onlinePeers.length)
            this.metricsService.setGauge(
                "peer_offline_count",
                offlinePeersCount,
            )
            this.metricsService.setGauge("peers_connected", onlinePeers.length)
            this.metricsService.setGauge("peers_total", allPeers.length)

            // Individual peer info (limit to avoid cardinality explosion)
            const peersToReport = allPeers.slice(0, MAX_PEERS_TO_REPORT)
            for (const peer of peersToReport) {
                const status = onlinePeers.some(
                    (p) => p.identity === peer.identity,
                )
                    ? "online"
                    : "offline"
                this.metricsService.setGauge("peer_info", 1, {
                    peer_id: peer.identity?.slice(0, 16) ?? "unknown",
                    url: peer.connection?.string ?? "unknown",
                    status,
                })
            }
        } catch (error) {
            log.debug(
                `[METRICS COLLECTOR] Peer metrics error: ${error instanceof Error ? error.message : String(error)}`,
            )
        }
    }

    /**
     * Check node HTTP endpoint health via GET / and /info
     * REVIEW: This checks if the node's RPC server is responding to HTTP requests
     * by calling the / (hello world) and /info (node info) endpoints.
     * Also extracts node info (version, identity) from /info response.
     */
    private async collectNodeHttpHealth(): Promise<void> {
        // RPC server uses SERVER_PORT or RPC_PORT, NOT OMNI_PORT (which is WebSocket)
        const rpcPort = Config.getInstance().server.rpcPort
        const baseUrl = `http://localhost:${rpcPort}`

        // Check root endpoint
        await this.checkEndpoint(baseUrl, "/", "root")

        // Check /info endpoint and extract node metadata
        await this.checkInfoEndpoint(baseUrl)
    }

    /**
     * Check a single HTTP endpoint health
     */
    private async checkEndpoint(
        baseUrl: string,
        path: string,
        name: string,
    ): Promise<boolean> {
        const startTime = Date.now()
        try {
            const controller = new AbortController()
            const timeout = setTimeout(() => controller.abort(), HTTP_HEALTH_CHECK_TIMEOUT_MS)

            const response = await fetch(`${baseUrl}${path}`, {
                method: "GET",
                signal: controller.signal,
            })

            clearTimeout(timeout)

            const responseTime = Date.now() - startTime
            const isHealthy = response.ok ? 1 : 0

            this.metricsService.setGauge("node_http_health", isHealthy, {
                endpoint: name,
            })
            this.metricsService.setGauge(
                "node_http_response_time_ms",
                responseTime,
                { endpoint: name },
            )
            return response.ok
        } catch {
            this.metricsService.setGauge("node_http_health", 0, {
                endpoint: name,
            })
            this.metricsService.setGauge("node_http_response_time_ms", 0, {
                endpoint: name,
            })
            return false
        }
    }

    /**
     * Check /info endpoint and extract node metadata for node_info metric
     */
    private async checkInfoEndpoint(baseUrl: string): Promise<void> {
        const startTime = Date.now()
        try {
            const controller = new AbortController()
            const timeout = setTimeout(() => controller.abort(), HTTP_HEALTH_CHECK_TIMEOUT_MS)

            const response = await fetch(`${baseUrl}/info`, {
                method: "GET",
                signal: controller.signal,
            })

            clearTimeout(timeout)

            const responseTime = Date.now() - startTime
            const isHealthy = response.ok ? 1 : 0

            this.metricsService.setGauge("node_http_health", isHealthy, {
                endpoint: "info",
            })
            this.metricsService.setGauge(
                "node_http_response_time_ms",
                responseTime,
                { endpoint: "info" },
            )

            // Extract node info from response if successful
            if (response.ok) {
                const info = (await response.json()) as {
                    version?: string
                    version_name?: string
                    identity?: string
                }

                // Set node_metadata metric with labels (value is always 1)
                this.metricsService.setGauge("node_metadata", 1, {
                    version: info.version || "unknown",
                    version_name: info.version_name || "unknown",
                    identity: info.identity
                        ? `${info.identity.slice(0, 10)}...${info.identity.slice(-6)}`
                        : "unknown",
                })
            }
        } catch {
            this.metricsService.setGauge("node_http_health", 0, {
                endpoint: "info",
            })
            this.metricsService.setGauge("node_http_response_time_ms", 0, {
                endpoint: "info",
            })
        }
    }

    /**
     * Check Docker container health
     * REVIEW: Container names from run script:
     *   - PostgreSQL: postgres_${PG_PORT} (e.g., postgres_5332)
     *   - TLSN: tlsn-notary-${TLSNOTARY_PORT} (e.g., tlsn-notary-7047)
     */
    private async collectDockerHealth(): Promise<void> {
        // Get ports from env to construct exact container names (matching run script)
        const pgPort = Config.getInstance().database.port
        const tlsnPort = Config.getInstance().tlsnotary.port

        // Container names match exactly what the run script creates
        const containers = [
            { name: `postgres_${pgPort}`, displayName: "postgres" },
            { name: `tlsn-notary-${tlsnPort}`, displayName: "tlsn" },
            { name: "ipfs", displayName: "ipfs" }, // IPFS uses simple name
        ]

        for (const { name, displayName } of containers) {
            try {
                const { stdout } = await execAsync(
                    `docker ps --filter "name=${name}" --format "{{.Status}}" 2>/dev/null || echo ""`,
                )
                const isUp = stdout.trim().toLowerCase().includes("up") ? 1 : 0
                this.metricsService.setGauge("service_docker_container_up", isUp, {
                    container: displayName,
                })
            } catch {
                // Docker not available or container not found
                this.metricsService.setGauge("service_docker_container_up", 0, {
                    container: displayName,
                })
            }
        }
    }

    /**
     * Check port health
     * REVIEW: Ports are read from environment variables matching the run script:
     *   - PG_PORT: PostgreSQL port (default 5332)
     *   - TLSNOTARY_PORT: TLSNotary port (default 7047)
     *   - OMNI_PORT: OmniProtocol port (default 53551)
     */
    private async collectPortHealth(): Promise<void> {
        // Read ports from environment variables (matching run script naming)
        const config = Config.getInstance()
        const postgresPort = config.database.port
        const tlsnPort = config.tlsnotary.port
        const omniPort = config.server.omniPort
        const ipfsSwarmPort = config.ipfs.swarmPort
        const ipfsApiPort = config.ipfs.apiPort

        const ports = [
            { port: postgresPort, service: "postgres" },
            { port: tlsnPort, service: "tlsn" },
            { port: omniPort, service: "omniprotocol" },
            { port: ipfsSwarmPort, service: "ipfs_swarm" },
            { port: ipfsApiPort, service: "ipfs_api" },
        ]

        for (const { port, service } of ports) {
            try {
                // Use netstat or ss to check if port is listening
                const { stdout } = await execAsync(
                    `ss -tlnp 2>/dev/null | grep ":${port} " || netstat -tlnp 2>/dev/null | grep ":${port} " || echo ""`,
                )
                const isOpen = stdout.trim().length > 0 ? 1 : 0
                this.metricsService.setGauge("service_port_open", isOpen, {
                    port,
                    service,
                })
            } catch {
                this.metricsService.setGauge("service_port_open", 0, {
                    port,
                    service,
                })
            }
        }
    }

    /**
     * Check if collector is running
     */
    public isRunning(): boolean {
        return this.running
    }
}

// Export singleton getter
export const getMetricsCollector = (
    config?: Partial<MetricsCollectorConfig>,
): MetricsCollector => MetricsCollector.getInstance(config)

export default MetricsCollector
