/**
 * LegacyLoggerAdapter - Backward compatibility layer for old Logger API
 *
 * This adapter allows existing code using the old Logger class to work
 * with the new CategorizedLogger without changes.
 *
 * Migration path:
 * 1. Import this adapter instead of the old Logger
 * 2. Gradually update code to use the new CategorizedLogger directly
 * 3. Once migration is complete, remove this adapter
 */

import { CategorizedLogger } from "./CategorizedLogger"
import { TAG_TO_CATEGORY } from "./tagCategories"
import { getSharedState } from "@/utilities/sharedState"
import fs from "fs"

/**
 * Extract tag from message like "[MAIN] Starting..." -> "MAIN"
 * Regex is designed to avoid ReDoS by:
 * - Using {1,50} limit on tag length instead of unbounded +
 * - Ensuring no overlapping quantifiers that cause backtracking
 */
function extractTag(message: string): { tag: string | null; cleanMessage: string } {
    // Limit tag to 50 chars max to prevent ReDoS, tags are typically short (e.g., "PEER BOOTSTRAP")
    const match = message.match(/^\[([A-Za-z0-9_ ]{1,50})\]\s*(.*)$/i)
    if (match) {
        return { tag: match[1].trim().toUpperCase(), cleanMessage: match[2] }
    }
    return { tag: null, cleanMessage: message }
}

/**
 * Infer category from tag or default to CORE
 */
function inferCategory(tag: string | null): LogCategory {
    if (!tag) return "CORE"
    return TAG_TO_CATEGORY[tag] ?? "CORE"
}

/**
 * LegacyLoggerAdapter - Drop-in replacement for old Logger class
 *
 * Provides the same API as the old Logger but routes to CategorizedLogger
 */
export default class LegacyLoggerAdapter {
    private static logger = CategorizedLogger.getInstance()

    // Preserve old static properties for compatibility
    static LOG_ONLY_ENABLED = false
    static LOGS_DIR = "logs"
    static LOG_INFO_FILE = "logs/info.log"
    static LOG_ERROR_FILE = "logs/error.log"
    static LOG_DEBUG_FILE = "logs/debug.log"
    static LOG_WARNING_FILE = "logs/warning.log"
    static LOG_CRITICAL_FILE = "logs/critical.log"
    static LOG_CUSTOM_PREFIX = "logs/custom_"

    // Override switch for logging to terminal (legacy compatibility)
    static logToTerminal: Record<string, boolean> = {
        peerGossip: false,
        last_shard: false,
    }

    /**
     * Set logs directory (legacy API)
     */
    static setLogsDir(port?: number): void {
        if (!port) {
            port = getSharedState.serverPort
        }

        try {
            const identityFile = getSharedState.identityFile?.replace(".", "") ?? ""
            const logsDir = `logs_${port}_${identityFile}`

            this.LOGS_DIR = logsDir
            this.LOG_INFO_FILE = `${logsDir}/info.log`
            this.LOG_ERROR_FILE = `${logsDir}/error.log`
            this.LOG_DEBUG_FILE = `${logsDir}/debug.log`
            this.LOG_WARNING_FILE = `${logsDir}/warning.log`
            this.LOG_CRITICAL_FILE = `${logsDir}/critical.log`
            this.LOG_CUSTOM_PREFIX = `${logsDir}/custom_`

            // Initialize the new logger with the same directory
            this.logger.initLogsDir(logsDir)
        } catch (error) {
            console.error("Error setting logs directory:", error)
            this.LOGS_DIR = "logs"
            this.logger.initLogsDir("logs")
        }

        // Log using new logger
        this.logger.info("CORE", `Logs directory set to: ${this.LOGS_DIR}`)
    }

    /**
     * Info level log (legacy API)
     */
    static info(message: string, logToTerminal = true): void {
        if (this.LOG_ONLY_ENABLED) return

        const { tag, cleanMessage } = extractTag(message)
        const category = inferCategory(tag)

        // Temporarily adjust terminal output based on parameter
        const config = this.logger.getConfig()
        const prevTerminal = config.terminalOutput

        if (!logToTerminal && !this.logger.isTuiMode()) {
            // In non-TUI mode, we need to suppress terminal for this call
            // We'll emit the event but not print
        }

        this.logger.info(category, cleanMessage)
    }

    /**
     * Error level log (legacy API)
     */
    static error(message: string, _logToTerminal = true): void {
        const { tag, cleanMessage } = extractTag(message)
        const category = inferCategory(tag)
        this.logger.error(category, cleanMessage)
    }

    /**
     * Debug level log (legacy API)
     */
    static debug(message: string, _logToTerminal = true): void {
        if (this.LOG_ONLY_ENABLED) return

        const { tag, cleanMessage } = extractTag(message)
        const category = inferCategory(tag)
        this.logger.debug(category, cleanMessage)
    }

    /**
     * Warning level log (legacy API)
     */
    static warning(message: string, _logToTerminal = true): void {
        if (this.LOG_ONLY_ENABLED) return

        const { tag, cleanMessage } = extractTag(message)
        const category = inferCategory(tag)
        this.logger.warning(category, cleanMessage)
    }

    /**
     * Critical level log (legacy API)
     */
    static critical(message: string, _logToTerminal = true): void {
        const { tag, cleanMessage } = extractTag(message)
        const category = inferCategory(tag)
        this.logger.critical(category, cleanMessage)
    }

    /**
     * Custom log file (legacy API)
     */
    static async custom(
        logfile: string,
        message: string,
        logToTerminal = true,
        cleanFile = false,
    ): Promise<void> {
        if (this.LOG_ONLY_ENABLED) return

        const customPath = `${this.LOG_CUSTOM_PREFIX}${logfile}.log`
        const timestamp = new Date().toISOString()
        const logEntry = `[INFO] [${timestamp}] ${message}\n`

        // Clean file if requested
        if (cleanFile) {
            try {
                fs.rmSync(customPath, { force: true })
                await fs.promises.writeFile(customPath, "")
            } catch {
                // Ignore errors
            }
        }

        // Write to custom file
        try {
            fs.appendFileSync(customPath, logEntry)
        } catch {
            // Ignore errors
        }

        // Log to terminal if enabled (but not in TUI mode)
        if (logToTerminal && this.logToTerminal[logfile] && !this.logger.isTuiMode()) {
            console.log(logEntry.trim())
        }
    }

    /**
     * Only mode (legacy API) - suppresses most logs
     */
    private static originalLog: typeof console.log | null = null

    static only(message: string, padWithNewLines = false): void {
        if (!this.LOG_ONLY_ENABLED) {
            this.logger.debug("CORE", "[LOG ONLY ENABLED]")
            this.LOG_ONLY_ENABLED = true

            // Suppress console.log in legacy mode
            // Note: In TUI mode this won't matter as output is controlled
            if (!this.logger.isTuiMode()) {
                this.originalLog = console.log
                console.log = () => {}
            }
        }

        // Always show "only" messages using the original console.log
        // (console.log may have been overwritten to a no-op above)
        const timestamp = new Date().toISOString()
        const logEntry = `[ONLY] [${timestamp}] ${message}`

        if (!this.logger.isTuiMode() && this.originalLog) {
            this.originalLog(
                `\x1b[1m\x1b[36m${logEntry}\x1b[0m${padWithNewLines ? "\n\n\n\n\n" : ""}`,
            )
        }

        // Also emit to TUI
        this.logger.info("CORE", message)
    }

    static disableOnlyMode(): void {
        if (this.LOG_ONLY_ENABLED && this.originalLog) {
            console.log = this.originalLog
            this.originalLog = null
        }
        this.LOG_ONLY_ENABLED = false
    }

    /**
     * Clean logs (legacy API)
     */
    static cleanLogs(withCustom = false): void {
        this.logger.cleanLogs(withCustom)

        // Also clean using legacy paths for compatibility
        if (fs.existsSync(this.LOGS_DIR)) {
            const files = fs.readdirSync(this.LOGS_DIR)
            for (const file of files) {
                if (file.startsWith("custom_") && !withCustom) {
                    continue
                }
                try {
                    fs.rmSync(`${this.LOGS_DIR}/${file}`, { force: true })
                } catch {
                    // Ignore errors
                }
            }
        }
    }

    /**
     * Get public logs (legacy API)
     */
    static getPublicLogs(): string {
        let logs = ""

        if (!fs.existsSync(this.LOGS_DIR)) {
            return "No logs directory found"
        }

        const files = fs
            .readdirSync(this.LOGS_DIR)
            .filter(file => file.startsWith("custom_"))

        logs += "Public logs:\n"
        logs += "==========\n"

        for (const file of files) {
            logs += `${file}\n`
            logs += "----------\n"
            try {
                logs += fs.readFileSync(`${this.LOGS_DIR}/${file}`, "utf8")
            } catch {
                logs += "(unable to read)\n"
            }
            logs += "\n\n"
        }

        return logs
    }

    /**
     * Get diagnostics (legacy API)
     */
    static getDiagnostics(): string {
        const diagnosticsPath = `${this.LOGS_DIR}/custom_diagnostics.log`
        try {
            return fs.readFileSync(diagnosticsPath, "utf8")
        } catch {
            return "No diagnostics available"
        }
    }

    // SECTION New API Access

    /**
     * Get the underlying CategorizedLogger instance
     * Use this for new code that wants to use the categorized API
     */
    static getCategorizedLogger(): CategorizedLogger {
        return this.logger
    }

    /**
     * Enable TUI mode
     */
    static enableTuiMode(): void {
        this.logger.enableTuiMode()
    }

    /**
     * Disable TUI mode
     */
    static disableTuiMode(): void {
        this.logger.disableTuiMode()
    }
}
