/**
 * TUI Module - Terminal User Interface for Demos Node
 *
 * This module provides:
 * - CategorizedLogger: TUI-ready categorized logging system
 * - LegacyLoggerAdapter: Backward compatibility for old Logger API
 * - TUIManager: Main TUI orchestrator with panels and controls
 */

// Core logger class
export { CategorizedLogger } from "./CategorizedLogger"

// Core logger types - use type-only exports for types and interfaces
export type {
    LogLevel,
    LogCategory,
    LogEntry,
    LoggerConfig,
} from "./CategorizedLogger"

// Legacy adapter
export { default as LegacyLoggerAdapter } from "./LegacyLoggerAdapter"

// TUI Manager class
export { TUIManager } from "./TUIManager"

// TUI Manager types - use type-only exports for interfaces
export type { NodeInfo, TUIConfig } from "./TUIManager"

// Default export is the singleton logger instance
export { default } from "./CategorizedLogger"
