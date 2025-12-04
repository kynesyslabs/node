/**
 * Logger - Backward compatibility wrapper
 *
 * This file re-exports LegacyLoggerAdapter as the default Logger class.
 * All existing code using `import log from "src/utilities/logger"` will
 * automatically use the new TUI-integrated categorized logging system.
 *
 * The LegacyLoggerAdapter:
 * - Maintains the same API as the old Logger
 * - Auto-detects tags like [MAIN], [PEER], etc. and maps to categories
 * - Routes all logs through CategorizedLogger for TUI display
 * - Preserves file logging functionality
 *
 * For new code, prefer using CategorizedLogger directly:
 * ```typescript
 * import { CategorizedLogger } from "@/utilities/tui"
 * const logger = CategorizedLogger.getInstance()
 * logger.info("CORE", "Starting the node")
 * ```
 */

export { default } from "./tui/LegacyLoggerAdapter"
export { default as Logger } from "./tui/LegacyLoggerAdapter"

// Also export the new logger for gradual migration
export { CategorizedLogger } from "./tui"
export type { LogCategory, LogLevel, LogEntry } from "./tui"
export { TUIManager } from "./tui"
export type { NodeInfo } from "./tui"
