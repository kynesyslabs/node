/**
 * Metrics Module - Prometheus metrics collection and exposure
 *
 * This module provides comprehensive metrics collection for the Demos Network node
 * using Prometheus format. It exposes metrics via HTTP endpoint for scraping.
 *
 * @module features/metrics
 */

// Types (canonical source)
export type {
    MetricsConfig,
    MetricsCollectorConfig,
    MetricsServerConfig,
} from "./types"

// Constants
export {
    METRICS_PREFIX,
    DEFAULT_METRICS_CONFIG,
    DEFAULT_COLLECTOR_CONFIG,
    DEFAULT_SERVER_CONFIG,
    DEFAULT_HISTOGRAM_BUCKETS,
    DEFAULT_SUMMARY_PERCENTILES,
    CONSENSUS_ROUND_DURATION_BUCKETS,
    PEER_LATENCY_BUCKETS,
    TRANSACTION_PROCESSING_BUCKETS,
    API_REQUEST_DURATION_BUCKETS,
    HTTP_HEALTH_CHECK_TIMEOUT_MS,
    MAX_PEERS_TO_REPORT,
    METRICS_SERVER_NAME,
    METRICS_SERVER_VERSION,
} from "./constants"

// Services
export { MetricsService, getMetricsService } from "./MetricsService"
export { MetricsServer, getMetricsServer } from "./MetricsServer"
export { MetricsCollector, getMetricsCollector } from "./MetricsCollector"
