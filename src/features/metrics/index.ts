/**
 * Metrics Module - Prometheus metrics collection and exposure
 *
 * This module provides comprehensive metrics collection for the Demos Network node
 * using Prometheus format. It exposes metrics via HTTP endpoint for scraping.
 *
 * @module features/metrics
 */

export {
    MetricsService,
    getMetricsService,
    type MetricsConfig,
} from "./MetricsService"

export {
    MetricsServer,
    getMetricsServer,
    type MetricsServerConfig,
} from "./MetricsServer"

export {
    MetricsCollector,
    getMetricsCollector,
    type MetricsCollectorConfig,
} from "./MetricsCollector"
