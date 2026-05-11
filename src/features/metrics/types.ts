/**
 * Metrics Module Types - Shared interfaces and type definitions
 *
 * Contains all interfaces and types used across the metrics module:
 * MetricsService, MetricsCollector, and MetricsServer.
 *
 * @module features/metrics
 */

// === MetricsService Types ===

export interface MetricsConfig {
    enabled: boolean
    port: number
    prefix: string
    defaultLabels?: Record<string, string>
    collectDefaultMetrics: boolean
}

// === MetricsCollector Types ===

export interface MetricsCollectorConfig {
    enabled: boolean
    collectionIntervalMs: number
    dockerHealthEnabled: boolean
    portHealthEnabled: boolean
}

// === MetricsServer Types ===

export interface MetricsServerConfig {
    port: number
    hostname: string
    enabled: boolean
}
