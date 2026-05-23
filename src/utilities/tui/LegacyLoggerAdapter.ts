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
import { TAG_TO_CATEGORY, type LogCategory } from "./tagCategories"
import { getSharedState } from "@/utilities/sharedState"
import fs from "fs"

/**
 * Stringify any value for logging - matches console.log behavior
 */
function stringify(value: unknown): string {
    if (typeof value === "string") return value
    if (value === null) return "null"
    if (value === undefined) return "undefined"
    if (value instanceof Error) return `${value.name}: ${value.message}`
    if (typeof value === "object") {
        try {
            return JSON.stringify(value)
        } catch {
            return String(value)
        }
    }
    return String(value)
}

/**
 * Parse leading [TAG] from a message and resolve it to a category.
 * Only strips the bracketed prefix when TAG is a recognized category tag —
 * unknown brackets (e.g. "[broadcastBlockHash]" or "[abc123]") are preserved
 * so the user sees the original message intact.
 *
 * Regex uses {1,50} length limit to avoid ReDoS.
 */
function parseMessage(message: string): {
    category: LogCategory
    cleanMessage: string
} {
    const match = message.match(/^\[([A-Za-z0-9_ ]{1,50})\]\s*(.*)$/i)
    if (match) {
        const tag = match[1].trim().toUpperCase()
        const category = TAG_TO_CATEGORY[tag]
        if (category) {
            return { category, cleanMessage: match[2] }
        }
    }
    return { category: "CORE", cleanMessage: message }
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
            const identityFile =
                getSharedState.identityFile?.replace(".", "") ?? ""
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
     * Accepts any type and stringifies automatically (matches console.log behavior)
     * Second parameter can be boolean (legacy logToTerminal) or additional data to log
     */
    static info(message: unknown, extra?: unknown): void {
        if (this.LOG_ONLY_ENABLED) return

        let stringified = stringify(message)
        // If extra is not a boolean, append it to the message (console.log style)
        if (extra !== undefined && typeof extra !== "boolean") {
            stringified += " " + stringify(extra)
        }
        const { category, cleanMessage } = parseMessage(stringified)

        this.logger.info(category, cleanMessage)
    }

    /**
     * Error level log (legacy API)
     * Accepts any type and stringifies automatically (matches console.log behavior)
     * Second parameter can be boolean (legacy logToTerminal) or additional data to log
     */
    static error(message: unknown, extra?: unknown): void {
        let stringified = stringify(message)
        // If extra is not a boolean, append it to the message (console.log style)
        if (extra !== undefined && typeof extra !== "boolean") {
            stringified += " " + stringify(extra)
        }
        const { category, cleanMessage } = parseMessage(stringified)
        this.logger.error(category, cleanMessage)
    }

    /**
     * Debug level log (legacy API)
     * Accepts any type and stringifies automatically (matches console.log behavior)
     * Second parameter can be boolean (legacy logToTerminal) or additional data to log
     */
    static debug(message: unknown, extra?: unknown): void {
        if (this.LOG_ONLY_ENABLED) return

        let stringified = stringify(message)
        // If extra is not a boolean, append it to the message (console.log style)
        if (extra !== undefined && typeof extra !== "boolean") {
            stringified += " " + stringify(extra)
        }
        const { category, cleanMessage } = parseMessage(stringified)
        this.logger.debug(category, cleanMessage)
    }

    /**
     * Warning level log (legacy API)
     * Accepts any type and stringifies automatically (matches console.log behavior)
     * Second parameter can be boolean (legacy logToTerminal) or additional data to log
     */
    static warning(message: unknown, extra?: unknown): void {
        if (this.LOG_ONLY_ENABLED) return

        let stringified = stringify(message)
        // If extra is not a boolean, append it to the message (console.log style)
        if (extra !== undefined && typeof extra !== "boolean") {
            stringified += " " + stringify(extra)
        }
        const { category, cleanMessage } = parseMessage(stringified)
        this.logger.warning(category, cleanMessage)
    }

    /**
     * Alias for warning() - for compatibility with code using warn()
     */
    static warn(message: unknown, extra?: unknown): void {
        this.warning(message, extra)
    }

    /**
     * Critical level log (legacy API)
     * Accepts any type and stringifies automatically (matches console.log behavior)
     * Second parameter can be boolean (legacy logToTerminal) or additional data to log
     */
    static critical(message: unknown, extra?: unknown): void {
        let stringified = stringify(message)
        // If extra is not a boolean, append it to the message (console.log style)
        if (extra !== undefined && typeof extra !== "boolean") {
            stringified += " " + stringify(extra)
        }
        const { category, cleanMessage } = parseMessage(stringified)
        this.logger.critical(category, cleanMessage)
    }

    /**
     * Custom log file (legacy API)
     * Accepts any type for message and stringifies automatically
     */
    static async custom(
        logfile: string,
        message: unknown,
        logToTerminal = true,
        cleanFile = false,
    ): Promise<void> {
        if (this.LOG_ONLY_ENABLED) return
        const stringifiedMessage = stringify(message)

        const customPath = `${this.LOG_CUSTOM_PREFIX}${logfile}.log`
        const timestamp = new Date().toISOString()
        const logEntry = `[INFO] [${timestamp}] ${stringifiedMessage}\n`

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
        if (
            logToTerminal &&
            this.logToTerminal[logfile] &&
            !this.logger.isTuiMode()
        ) {
            console.log(logEntry.trim())
        }
    }

    /**
     * Only mode (legacy API) - suppresses most logs
     * Accepts any type for message and stringifies automatically
     */
    private static originalLog: typeof console.log | null = null

    static only(message: unknown, padWithNewLines = false): void {
        return this.debug(message, padWithNewLines)

        const stringifiedMessage = stringify(message)
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
        const logEntry = `[ONLY] [${timestamp}] ${stringifiedMessage}`

        if (!this.logger.isTuiMode() && this.originalLog) {
            this.originalLog(
                `\x1b[1m\x1b[36m${logEntry}\x1b[0m${padWithNewLines ? "\n\n\n\n\n" : ""}`,
            )
        }

        // Also emit to TUI
        // this.logger.info("CORE", stringifiedMessage)
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
