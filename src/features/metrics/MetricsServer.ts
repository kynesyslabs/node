/**
 * MetricsServer - HTTP server for Prometheus metrics endpoint
 *
 * Provides a dedicated HTTP server exposing the /metrics endpoint
 * for Prometheus scraping. Runs on a separate port from the main RPC server.
 *
 * @module features/metrics
 */

import { Server } from "bun"
import log from "@/utilities/logger"
import { MetricsService } from "./MetricsService"

// REVIEW: Metrics server configuration
export interface MetricsServerConfig {
    port: number
    hostname: string
    enabled: boolean
}

const DEFAULT_CONFIG: MetricsServerConfig = {
    port: parseInt(process.env.METRICS_PORT ?? "9090", 10),
    hostname: process.env.METRICS_HOST ?? "0.0.0.0",
    enabled: process.env.METRICS_ENABLED?.toLowerCase() !== "false",
}

/**
 * MetricsServer - Dedicated HTTP server for Prometheus metrics
 *
 * Usage:
 * ```typescript
 * const server = new MetricsServer()
 * await server.start()
 * // Prometheus scrapes http://localhost:9090/metrics
 * ```
 */
export class MetricsServer {
    private server: Server | null = null
    private config: MetricsServerConfig
    private metricsService: MetricsService

    constructor(config?: Partial<MetricsServerConfig>) {
        this.config = { ...DEFAULT_CONFIG, ...config }
        this.metricsService = MetricsService.getInstance()
    }

    /**
     * Start the metrics HTTP server
     */
    public async start(): Promise<void> {
        if (!this.config.enabled) {
            log.info("[METRICS SERVER] Metrics server is disabled")
            return
        }

        if (this.server) {
            log.warning("[METRICS SERVER] Server already running")
            return
        }

        // Initialize the metrics service if not already done
        await this.metricsService.initialize()

        this.server = Bun.serve({
            port: this.config.port,
            hostname: this.config.hostname,
            fetch: async (req) => this.handleRequest(req),
        })

        log.info(
            `[METRICS SERVER] Started on http://${this.config.hostname}:${this.config.port}/metrics`,
        )
    }

    /**
     * Handle incoming HTTP requests
     */
    private async handleRequest(req: Request): Promise<Response> {
        const url = new URL(req.url)
        const path = url.pathname

        // Health check endpoint
        if (path === "/health" || path === "/healthz") {
            return new Response(JSON.stringify({ status: "ok" }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            })
        }

        // Metrics endpoint
        if (path === "/metrics") {
            try {
                const metrics = await this.metricsService.getMetrics()
                return new Response(metrics, {
                    status: 200,
                    headers: {
                        "Content-Type": this.metricsService.getContentType(),
                    },
                })
            } catch (error) {
                log.error(
                    `[METRICS SERVER] Error generating metrics: ${error}`,
                )
                return new Response("Internal Server Error", { status: 500 })
            }
        }

        // Root endpoint - basic info
        if (path === "/") {
            return new Response(
                JSON.stringify({
                    name: "Demos Network Metrics Server",
                    version: "1.0.0",
                    endpoints: {
                        metrics: "/metrics",
                        health: "/health",
                    },
                }),
                {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                },
            )
        }

        // Not found
        return new Response("Not Found", { status: 404 })
    }

    /**
     * Stop the metrics server
     */
    public stop(): void {
        if (this.server) {
            this.server.stop()
            this.server = null
            log.info("[METRICS SERVER] Stopped")
        }
    }

    /**
     * Check if server is running
     */
    public isRunning(): boolean {
        return this.server !== null
    }

    /**
     * Get the server port
     */
    public getPort(): number {
        return this.config.port
    }
}

// Export singleton getter for convenience
let metricsServerInstance: MetricsServer | null = null

export const getMetricsServer = (
    config?: Partial<MetricsServerConfig>,
): MetricsServer => {
    if (!metricsServerInstance) {
        metricsServerInstance = new MetricsServer(config)
    }
    return metricsServerInstance
}

export default MetricsServer
