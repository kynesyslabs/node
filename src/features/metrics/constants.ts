/**
 * Metrics Module Constants - Hardcoded values, defaults, and magic numbers
 *
 * Centralizes all default configuration values, histogram bucket definitions,
 * metric name prefixes, and other constants used across the metrics module.
 *
 * @module features/metrics
 */

import { Config } from "src/config"
import type {
    MetricsConfig,
    MetricsCollectorConfig,
    MetricsServerConfig,
} from "./types"

// === Metric Prefix ===

/** Prefix applied to all Prometheus metric names */
export const METRICS_PREFIX = "demos_"

// === Default Configurations ===

export const DEFAULT_METRICS_CONFIG: MetricsConfig = {
    enabled: Config.getInstance().metrics.enabled,
    port: Config.getInstance().metrics.port,
    prefix: METRICS_PREFIX,
    collectDefaultMetrics: true,
}

export const DEFAULT_COLLECTOR_CONFIG: MetricsCollectorConfig = {
    enabled: true,
    collectionIntervalMs: 2500, // 2.5 seconds - faster updates for real-time monitoring
    dockerHealthEnabled: true,
    portHealthEnabled: true,
}

export const DEFAULT_SERVER_CONFIG: MetricsServerConfig = {
    port: Config.getInstance().metrics.port,
    hostname: Config.getInstance().metrics.host,
    enabled: Config.getInstance().metrics.enabled,
}

// === Histogram Bucket Definitions ===

/** Default histogram buckets used when no specific buckets are provided */
export const DEFAULT_HISTOGRAM_BUCKETS = [
    0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
]

/** Default summary percentiles */
export const DEFAULT_SUMMARY_PERCENTILES = [0.5, 0.9, 0.95, 0.99]

/** Buckets for consensus round duration measurements */
export const CONSENSUS_ROUND_DURATION_BUCKETS = [0.1, 0.5, 1, 2, 5, 10, 30]

/** Buckets for peer communication latency measurements */
export const PEER_LATENCY_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]

/** Buckets for transaction processing time measurements */
export const TRANSACTION_PROCESSING_BUCKETS = [
    0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5,
]

/** Buckets for API request duration measurements */
export const API_REQUEST_DURATION_BUCKETS = [
    0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
]

// === Collection & Timeout Constants ===

/** Timeout in milliseconds for HTTP health check requests */
export const HTTP_HEALTH_CHECK_TIMEOUT_MS = 5000

/** Maximum number of individual peers to report in metrics (avoids cardinality explosion) */
export const MAX_PEERS_TO_REPORT = 20

// === Server Info Constants ===

/** Display name for the metrics server root endpoint */
export const METRICS_SERVER_NAME = "Demos Network Metrics Server"

/** Version string for the metrics server root endpoint */
export const METRICS_SERVER_VERSION = "1.0.0"
