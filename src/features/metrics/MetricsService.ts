/**
 * MetricsService - Core Prometheus metrics registry and management
 *
 * Provides a centralized service for collecting and exposing Prometheus metrics
 * from the Demos Network node. Implements singleton pattern for global access.
 *
 * @module features/metrics
 */

import client, {
    Registry,
    Counter,
    Gauge,
    Histogram,
    Summary,
    collectDefaultMetrics,
} from "prom-client"
import log from "@/utilities/logger"
import type { MetricsConfig } from "./types"
import {
    DEFAULT_METRICS_CONFIG,
    DEFAULT_HISTOGRAM_BUCKETS,
    DEFAULT_SUMMARY_PERCENTILES,
    CONSENSUS_ROUND_DURATION_BUCKETS,
    PEER_LATENCY_BUCKETS,
    TRANSACTION_PROCESSING_BUCKETS,
    API_REQUEST_DURATION_BUCKETS,
} from "./constants"

// Re-export for backward compatibility
export type { MetricsConfig } from "./types"

/**
 * MetricsService - Singleton service for Prometheus metrics
 *
 * Usage:
 * ```typescript
 * const metrics = MetricsService.getInstance()
 * metrics.incrementCounter('transactions_total', { type: 'native' })
 * ```
 */
export class MetricsService {
    private static instance: MetricsService | null = null
    private registry: Registry
    private config: MetricsConfig
    private initialized = false

    // Metric storage maps
    private counters: Map<string, Counter<string>> = new Map()
    private gauges: Map<string, Gauge<string>> = new Map()
    private histograms: Map<string, Histogram<string>> = new Map()
    private summaries: Map<string, Summary<string>> = new Map()

    // Node start time for uptime calculation
    private startTime: number = Date.now()

    private constructor(config?: Partial<MetricsConfig>) {
        this.config = { ...DEFAULT_METRICS_CONFIG, ...config }
        this.registry = new Registry()

        if (this.config.defaultLabels) {
            this.registry.setDefaultLabels(this.config.defaultLabels)
        }
    }

    /**
     * Get the singleton instance of MetricsService
     */
    public static getInstance(config?: Partial<MetricsConfig>): MetricsService {
        if (!MetricsService.instance) {
            MetricsService.instance = new MetricsService(config)
        }
        return MetricsService.instance
    }

    /**
     * Initialize the metrics service
     * Sets up default metrics collection and registers built-in metrics
     */
    public async initialize(): Promise<void> {
        if (this.initialized) {
            log.warning("[METRICS] MetricsService already initialized")
            return
        }

        if (!this.config.enabled) {
            log.info("[METRICS] Metrics collection is disabled")
            return
        }

        log.info("[METRICS] Initializing MetricsService...")

        // Collect default Node.js metrics (memory, CPU, event loop, etc.)
        if (this.config.collectDefaultMetrics) {
            collectDefaultMetrics({
                register: this.registry,
                prefix: this.config.prefix,
            })
        }

        // Register core Demos metrics
        this.registerCoreMetrics()

        this.initialized = true
        log.info(
            `[METRICS] MetricsService initialized (configured port: ${this.config.port})`,
        )
    }

    /**
     * Register core Demos node metrics
     */
    private registerCoreMetrics(): void {
        // === System Metrics ===
        this.createGauge("node_uptime_seconds", "Node uptime in seconds", [])
        this.createGauge("node_info", "Node information", [
            "version",
            "node_id",
        ])

        // === Consensus Metrics ===
        this.createCounter(
            "consensus_rounds_total",
            "Total consensus rounds completed",
            [],
        )
        this.createHistogram(
            "consensus_round_duration_seconds",
            "Duration of consensus rounds",
            [],
            CONSENSUS_ROUND_DURATION_BUCKETS,
        )
        this.createGauge("block_height", "Current block height", [])
        this.createGauge("mempool_size", "Number of pending transactions", [])

        // === Network Metrics ===
        this.createGauge("peers_connected", "Currently connected peers", [])
        this.createGauge("peers_total", "Total known peers", [])
        this.createCounter(
            "messages_sent_total",
            "Total messages sent",
            ["type"],
        )
        this.createCounter(
            "messages_received_total",
            "Total messages received",
            ["type"],
        )
        // REVIEW: Peer latency histogram - no peer_id label to avoid cardinality explosion
        // Use aggregated latency across all peers; individual peer debugging should use logs
        this.createHistogram(
            "peer_latency_seconds",
            "Peer communication latency (aggregated across all peers)",
            [], // No labels to prevent unbounded cardinality
            PEER_LATENCY_BUCKETS,
        )

        // === Transaction Metrics ===
        this.createCounter(
            "transactions_total",
            "Total transactions processed",
            ["type", "status"],
        )
        this.createCounter(
            "transactions_failed_total",
            "Total failed transactions",
            ["type", "reason"],
        )
        this.createGauge("tps", "Current transactions per second", [])
        this.createHistogram(
            "transaction_processing_seconds",
            "Transaction processing time",
            ["type"],
            TRANSACTION_PROCESSING_BUCKETS,
        )

        // === API Metrics ===
        this.createCounter(
            "api_requests_total",
            "Total API requests",
            ["method", "endpoint", "status_code"],
        )
        this.createHistogram(
            "api_request_duration_seconds",
            "API request duration",
            ["method", "endpoint"],
            API_REQUEST_DURATION_BUCKETS,
        )
        this.createCounter(
            "api_errors_total",
            "Total API errors",
            ["method", "endpoint", "error_code"],
        )

        // === IPFS Metrics ===
        this.createGauge("ipfs_pins_total", "Total pinned content items", [])
        this.createGauge("ipfs_storage_bytes", "Total IPFS storage used", [])
        this.createGauge("ipfs_peers", "Connected IPFS swarm peers", [])
        this.createCounter(
            "ipfs_operations_total",
            "Total IPFS operations",
            ["operation"],
        )

        // === GCR Metrics ===
        this.createGauge("gcr_accounts_total", "Total accounts in GCR", [])
        this.createGauge(
            "gcr_total_supply",
            "Total native token supply",
            [],
        )

        log.debug("[METRICS] Core metrics registered")
    }

    // === Metric Creation Methods ===

    /**
     * Create and register a Counter metric
     */
    public createCounter(
        name: string,
        help: string,
        labelNames: string[],
    ): Counter<string> {
        const fullName = this.config.prefix + name
        const existing = this.counters.get(fullName)
        if (existing) {
            return existing
        }

        const counter = new Counter({
            name: fullName,
            help,
            labelNames,
            registers: [this.registry],
        })
        this.counters.set(fullName, counter)
        return counter
    }

    /**
     * Create and register a Gauge metric
     */
    public createGauge(
        name: string,
        help: string,
        labelNames: string[],
    ): Gauge<string> {
        const fullName = this.config.prefix + name
        const existing = this.gauges.get(fullName)
        if (existing) {
            return existing
        }

        const gauge = new Gauge({
            name: fullName,
            help,
            labelNames,
            registers: [this.registry],
        })
        this.gauges.set(fullName, gauge)
        return gauge
    }

    /**
     * Create and register a Histogram metric
     */
    public createHistogram(
        name: string,
        help: string,
        labelNames: string[],
        buckets?: number[],
    ): Histogram<string> {
        const fullName = this.config.prefix + name
        const existing = this.histograms.get(fullName)
        if (existing) {
            return existing
        }

        const histogram = new Histogram({
            name: fullName,
            help,
            labelNames,
            buckets: buckets ?? DEFAULT_HISTOGRAM_BUCKETS,
            registers: [this.registry],
        })
        this.histograms.set(fullName, histogram)
        return histogram
    }

    /**
     * Create and register a Summary metric
     */
    public createSummary(
        name: string,
        help: string,
        labelNames: string[],
        percentiles?: number[],
    ): Summary<string> {
        const fullName = this.config.prefix + name
        const existing = this.summaries.get(fullName)
        if (existing) {
            return existing
        }

        const summary = new Summary({
            name: fullName,
            help,
            labelNames,
            percentiles: percentiles ?? DEFAULT_SUMMARY_PERCENTILES,
            registers: [this.registry],
        })
        this.summaries.set(fullName, summary)
        return summary
    }

    // === Metric Update Methods ===

    /**
     * Increment a counter metric
     */
    public incrementCounter(
        name: string,
        labels?: Record<string, string>,
        value = 1,
    ): void {
        if (!this.config.enabled) return
        const fullName = this.config.prefix + name
        const counter = this.counters.get(fullName)
        if (counter) {
            if (labels) {
                counter.inc(labels, value)
            } else {
                counter.inc(value)
            }
        }
    }

    /**
     * Set a gauge metric value
     */
    public setGauge(
        name: string,
        value: number,
        labels?: Record<string, string>,
    ): void {
        if (!this.config.enabled) return
        const fullName = this.config.prefix + name
        const gauge = this.gauges.get(fullName)
        if (gauge) {
            if (labels) {
                gauge.set(labels, value)
            } else {
                gauge.set(value)
            }
        }
    }

    /**
     * Increment a gauge metric
     */
    public incrementGauge(
        name: string,
        labels?: Record<string, string>,
        value = 1,
    ): void {
        if (!this.config.enabled) return
        const fullName = this.config.prefix + name
        const gauge = this.gauges.get(fullName)
        if (gauge) {
            if (labels) {
                gauge.inc(labels, value)
            } else {
                gauge.inc(value)
            }
        }
    }

    /**
     * Decrement a gauge metric
     */
    public decrementGauge(
        name: string,
        labels?: Record<string, string>,
        value = 1,
    ): void {
        if (!this.config.enabled) return
        const fullName = this.config.prefix + name
        const gauge = this.gauges.get(fullName)
        if (gauge) {
            if (labels) {
                gauge.dec(labels, value)
            } else {
                gauge.dec(value)
            }
        }
    }

    /**
     * Observe a histogram value
     */
    public observeHistogram(
        name: string,
        value: number,
        labels?: Record<string, string>,
    ): void {
        if (!this.config.enabled) return
        const fullName = this.config.prefix + name
        const histogram = this.histograms.get(fullName)
        if (histogram) {
            if (labels) {
                histogram.observe(labels, value)
            } else {
                histogram.observe(value)
            }
        }
    }

    /**
     * Start a histogram timer - returns a function to call when done
     */
    public startHistogramTimer(
        name: string,
        labels?: Record<string, string>,
    ): () => number {
        if (!this.config.enabled) return () => 0
        const fullName = this.config.prefix + name
        const histogram = this.histograms.get(fullName)
        if (histogram) {
            if (labels) {
                return histogram.startTimer(labels)
            } else {
                return histogram.startTimer()
            }
        }
        return () => 0
    }

    /**
     * Observe a summary value
     */
    public observeSummary(
        name: string,
        value: number,
        labels?: Record<string, string>,
    ): void {
        if (!this.config.enabled) return
        const fullName = this.config.prefix + name
        const summary = this.summaries.get(fullName)
        if (summary) {
            if (labels) {
                summary.observe(labels, value)
            } else {
                summary.observe(value)
            }
        }
    }

    // === Utility Methods ===

    /**
     * Get the Prometheus registry
     */
    public getRegistry(): Registry {
        return this.registry
    }

    /**
     * Get metrics in Prometheus format
     */
    public async getMetrics(): Promise<string> {
        // Update uptime before returning metrics
        this.updateUptime()
        return this.registry.metrics()
    }

    /**
     * Get content type for metrics response
     */
    public getContentType(): string {
        return this.registry.contentType
    }

    /**
     * Update the uptime gauge
     */
    private updateUptime(): void {
        const uptimeSeconds = (Date.now() - this.startTime) / 1000
        this.setGauge("node_uptime_seconds", uptimeSeconds)
    }

    /**
     * Check if metrics are enabled
     */
    public isEnabled(): boolean {
        return this.config.enabled
    }

    /**
     * Get the configured port
     */
    public getPort(): number {
        return this.config.port
    }

    /**
     * Reset all metrics (useful for testing)
     */
    public async reset(): Promise<void> {
        await this.registry.resetMetrics()
    }

    /**
     * Shutdown the metrics service
     */
    public async shutdown(): Promise<void> {
        log.info("[METRICS] Shutting down MetricsService...")
        this.initialized = false
    }
}

// Export singleton instance getter
export const getMetricsService = (
    config?: Partial<MetricsConfig>,
): MetricsService => MetricsService.getInstance(config)

export default MetricsService
