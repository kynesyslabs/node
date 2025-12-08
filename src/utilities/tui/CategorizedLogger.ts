/**
 * CategorizedLogger - TUI-ready categorized logging system
 *
 * Provides categorized logging with event emission for TUI integration,
 * ring buffer for in-memory storage, and backward-compatible file logging.
 */

import { EventEmitter } from "events"
import fs from "fs"
import path from "path"

// Capture original console.error at module initialization to avoid TUI interception/recursion
const originalConsoleError = console.error.bind(console)

// SECTION Types and Interfaces

/**
 * Log severity levels
 */
export type LogLevel = "debug" | "info" | "warning" | "error" | "critical"

/**
 * Log categories for filtering and organization
 */
export type LogCategory =
    | "CORE" // Main bootstrap, warmup, general operations
    | "NETWORK" // RPC server, connections, HTTP endpoints
    | "PEER" // Peer management, peer gossip, peer bootstrap
    | "CHAIN" // Blockchain, blocks, mempool
    | "SYNC" // Synchronization operations
    | "CONSENSUS" // PoR BFT consensus operations
    | "IDENTITY" // GCR, identity management
    | "MCP" // MCP server operations
    | "MULTICHAIN" // Cross-chain/XM operations
    | "DAHR" // DAHR-specific operations

/**
 * A single log entry
 */
export interface LogEntry {
    id: number
    level: LogLevel
    category: LogCategory
    message: string
    timestamp: Date
}

/**
 * Logger configuration options
 */
export interface LoggerConfig {
    /** Maximum entries in ring buffer (default: 1000) */
    bufferSize?: number
    /** Directory for log files (default: "logs") */
    logsDir?: string
    /** Whether to output to terminal (default: true in non-TUI mode) */
    terminalOutput?: boolean
    /** Minimum log level to display (default: "debug") */
    minLevel?: LogLevel
    /** Categories to show (empty = all) */
    enabledCategories?: LogCategory[]
}

// SECTION Ring Buffer Implementation

/**
 * Fixed-size circular buffer for storing log entries
 */
class RingBuffer<T> {
    private buffer: (T | undefined)[]
    private head = 0
    private tail = 0
    private _size = 0
    private capacity: number

    constructor(capacity: number) {
        this.capacity = capacity
        this.buffer = new Array(capacity)
    }

    /**
     * Add an item to the buffer
     */
    push(item: T): void {
        this.buffer[this.tail] = item
        this.tail = (this.tail + 1) % this.capacity

        if (this._size < this.capacity) {
            this._size++
        } else {
            // Buffer is full, move head forward
            this.head = (this.head + 1) % this.capacity
        }
    }

    /**
     * Get all items in order (oldest to newest)
     */
    getAll(): T[] {
        const result: T[] = []
        for (let i = 0; i < this._size; i++) {
            const index = (this.head + i) % this.capacity
            const item = this.buffer[index]
            if (item !== undefined) {
                result.push(item)
            }
        }
        return result
    }

    /**
     * Get last N items (newest)
     */
    getLast(n: number): T[] {
        const all = this.getAll()
        return all.slice(-n)
    }

    /**
     * Filter items by predicate
     */
    filter(predicate: (item: T) => boolean): T[] {
        return this.getAll().filter(predicate)
    }

    /**
     * Current number of items
     */
    get size(): number {
        return this._size
    }

    /**
     * Clear all items
     */
    clear(): void {
        this.buffer = new Array(this.capacity)
        this.head = 0
        this.tail = 0
        this._size = 0
    }
}

// SECTION Logger Events

export interface LoggerEvents {
    log: (entry: LogEntry) => void
    clear: () => void
    categoryChange: (categories: LogCategory[]) => void
    levelChange: (level: LogLevel) => void
}

// SECTION Level Priority Map

const LEVEL_PRIORITY: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warning: 2,
    error: 3,
    critical: 4,
}

// SECTION Color codes for terminal output (when not in TUI mode)

const LEVEL_COLORS: Record<LogLevel, string> = {
    debug: "\x1b[35m", // Magenta
    info: "\x1b[37m", // White
    warning: "\x1b[33m", // Yellow
    error: "\x1b[31m", // Red
    critical: "\x1b[1m\x1b[31m", // Bold Red
}

const RESET_COLOR = "\x1b[0m"

// SECTION Main Logger Class

/**
 * All available log categories
 */
const ALL_CATEGORIES: LogCategory[] = [
    "CORE",
    "NETWORK",
    "PEER",
    "CHAIN",
    "SYNC",
    "CONSENSUS",
    "IDENTITY",
    "MCP",
    "MULTICHAIN",
    "DAHR",
]

/**
 * CategorizedLogger - Singleton logger with category support and TUI integration
 */
export class CategorizedLogger extends EventEmitter {
    private static instance: CategorizedLogger | null = null

    // Per-category buffers to prevent log loss when one category is very active
    private categoryBuffers: Map<LogCategory, RingBuffer<LogEntry>> = new Map()
    private config: Required<LoggerConfig>
    private entryCounter = 0
    private fileHandles: Map<string, fs.WriteStream> = new Map()
    private logsInitialized = false

    // TUI mode flag - when true, suppress direct terminal output
    private tuiMode = false

    private constructor(config: LoggerConfig = {}) {
        super()
        this.config = {
            bufferSize: config.bufferSize ?? 500, // Per-category buffer size
            logsDir: config.logsDir ?? "logs",
            terminalOutput: config.terminalOutput ?? true,
            minLevel: config.minLevel ?? "debug",
            enabledCategories: config.enabledCategories ?? [],
        }
        // Initialize a buffer for each category
        for (const category of ALL_CATEGORIES) {
            this.categoryBuffers.set(category, new RingBuffer<LogEntry>(this.config.bufferSize))
        }
    }

    /**
     * Get the singleton instance
     */
    static getInstance(config?: LoggerConfig): CategorizedLogger {
        if (!CategorizedLogger.instance) {
            CategorizedLogger.instance = new CategorizedLogger(config)
        }
        return CategorizedLogger.instance
    }

    /**
     * Reset the singleton (useful for testing)
     */
    static resetInstance(): void {
        if (CategorizedLogger.instance) {
            CategorizedLogger.instance.closeFileHandles()
            CategorizedLogger.instance = null
        }
    }

    // SECTION Configuration Methods

    /**
     * Initialize the logs directory
     */
    initLogsDir(logsDir?: string, suffix?: string): void {
        if (logsDir) {
            this.config.logsDir = logsDir
        }
        if (suffix) {
            this.config.logsDir = `${this.config.logsDir}_${suffix}`
        }

        // Create directory if it doesn't exist
        if (!fs.existsSync(this.config.logsDir)) {
            fs.mkdirSync(this.config.logsDir, { recursive: true })
        }

        this.logsInitialized = true
    }

    /**
     * Enable TUI mode (suppresses direct terminal output)
     */
    enableTuiMode(): void {
        this.tuiMode = true
        this.config.terminalOutput = false
    }

    /**
     * Disable TUI mode (enables direct terminal output)
     */
    disableTuiMode(): void {
        this.tuiMode = false
        this.config.terminalOutput = true
    }

    /**
     * Check if TUI mode is enabled
     */
    isTuiMode(): boolean {
        return this.tuiMode
    }

    /**
     * Set minimum log level
     */
    setMinLevel(level: LogLevel): void {
        this.config.minLevel = level
        this.emit("levelChange", level)
    }

    /**
     * Set enabled categories (empty = all)
     */
    setEnabledCategories(categories: LogCategory[]): void {
        this.config.enabledCategories = categories
        this.emit("categoryChange", categories)
    }

    /**
     * Get current configuration
     */
    getConfig(): Required<LoggerConfig> {
        return { ...this.config }
    }

    // SECTION Logging Methods

    /**
     * Core logging method
     */
    private log(
        level: LogLevel,
        category: LogCategory,
        message: string,
    ): LogEntry {
        const entry: LogEntry = {
            id: ++this.entryCounter,
            level,
            category,
            message,
            timestamp: new Date(),
        }

        // Add to category-specific ring buffer
        const categoryBuffer = this.categoryBuffers.get(category)
        if (categoryBuffer) {
            categoryBuffer.push(entry)
        }

        // Emit event for TUI
        this.emit("log", entry)

        // Write to file
        this.writeToFile(entry)

        // Terminal output (if enabled and not in TUI mode)
        if (this.config.terminalOutput && !this.tuiMode) {
            this.writeToTerminal(entry)
        }

        return entry
    }

    /**
     * Check if a log should be displayed based on level and category filters
     */
    private shouldLog(level: LogLevel, category: LogCategory): boolean {
        // Check level
        if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.config.minLevel]) {
            return false
        }

        // Check category (empty = all enabled)
        if (
            this.config.enabledCategories.length > 0 &&
            !this.config.enabledCategories.includes(category)
        ) {
            return false
        }

        return true
    }

    /**
     * Debug level log
     */
    debug(category: LogCategory, message: string): LogEntry | null {
        if (!this.shouldLog("debug", category)) return null
        return this.log("debug", category, message)
    }

    /**
     * Info level log
     */
    info(category: LogCategory, message: string): LogEntry | null {
        if (!this.shouldLog("info", category)) return null
        return this.log("info", category, message)
    }

    /**
     * Warning level log
     */
    warning(category: LogCategory, message: string): LogEntry | null {
        if (!this.shouldLog("warning", category)) return null
        return this.log("warning", category, message)
    }

    /**
     * Error level log
     */
    error(category: LogCategory, message: string): LogEntry | null {
        if (!this.shouldLog("error", category)) return null
        return this.log("error", category, message)
    }

    /**
     * Critical level log
     */
    critical(category: LogCategory, message: string): LogEntry | null {
        if (!this.shouldLog("critical", category)) return null
        return this.log("critical", category, message)
    }

    // SECTION File Logging

    /**
     * Write a log entry to appropriate files
     */
    private writeToFile(entry: LogEntry): void {
        if (!this.logsInitialized) return

        const logLine = this.formatLogLine(entry)

        // Write to main log file
        this.appendToFile("all.log", logLine)

        // Write to level-specific file
        this.appendToFile(`${entry.level}.log`, logLine)

        // Write to category-specific file
        this.appendToFile(`category_${entry.category.toLowerCase()}.log`, logLine)
    }

    /**
     * Append a line to a log file
     */
    private appendToFile(filename: string, content: string): void {
        const filepath = path.join(this.config.logsDir, filename)

        fs.promises.appendFile(filepath, content).catch(err => {
            // Silently fail file writes to avoid recursion.
            // Using the captured original console.error to bypass TUI interception.
            originalConsoleError(`Failed to write to log file: ${filepath}`, err)
        })
    }

    /**
     * Format a log entry as a string
     */
    private formatLogLine(entry: LogEntry): string {
        const timestamp = entry.timestamp.toISOString()
        const level = entry.level.toUpperCase().padEnd(8)
        const category = entry.category.padEnd(10)
        return `[${timestamp}] [${level}] [${category}] ${entry.message}\n`
    }

    /**
     * Close all file handles
     */
    private closeFileHandles(): void {
        for (const stream of this.fileHandles.values()) {
            stream.close()
        }
        this.fileHandles.clear()
    }

    // SECTION Terminal Output

    /**
     * Write to terminal with colors
     */
    private writeToTerminal(entry: LogEntry): void {
        const timestamp = entry.timestamp.toISOString().split("T")[1].slice(0, 8)
        const level = entry.level.toUpperCase().padEnd(8)
        const category = entry.category.padEnd(10)
        const color = LEVEL_COLORS[entry.level]

        const line = `${color}[${timestamp}] [${level}] [${category}] ${entry.message}${RESET_COLOR}`
        console.log(line)
    }

    // SECTION Buffer Access Methods

    /**
     * Get all log entries (merged from all categories, sorted by timestamp)
     */
    getAllEntries(): LogEntry[] {
        const allEntries: LogEntry[] = []
        for (const buffer of this.categoryBuffers.values()) {
            allEntries.push(...buffer.getAll())
        }
        // Sort by entry ID to maintain chronological order
        return allEntries.sort((a, b) => a.id - b.id)
    }

    /**
     * Get last N entries (from all categories combined)
     */
    getLastEntries(n: number): LogEntry[] {
        const allEntries = this.getAllEntries()
        return allEntries.slice(-n)
    }

    /**
     * Get entries by category (directly from category buffer)
     */
    getEntriesByCategory(category: LogCategory): LogEntry[] {
        const buffer = this.categoryBuffers.get(category)
        return buffer ? buffer.getAll() : []
    }

    /**
     * Get entries by level (from all categories)
     */
    getEntriesByLevel(level: LogLevel): LogEntry[] {
        const allEntries = this.getAllEntries()
        return allEntries.filter(e => e.level === level)
    }

    /**
     * Get entries by category and level
     */
    getEntries(category?: LogCategory, level?: LogLevel): LogEntry[] {
        if (category) {
            const entries = this.getEntriesByCategory(category)
            return level ? entries.filter(e => e.level === level) : entries
        }
        const allEntries = this.getAllEntries()
        return level ? allEntries.filter(e => e.level === level) : allEntries
    }

    /**
     * Clear all buffers
     */
    clearBuffer(): void {
        for (const buffer of this.categoryBuffers.values()) {
            buffer.clear()
        }
        this.emit("clear")
    }

    /**
     * Get total buffer size (sum of all category buffers)
     */
    getBufferSize(): number {
        let total = 0
        for (const buffer of this.categoryBuffers.values()) {
            total += buffer.size
        }
        return total
    }

    // SECTION Utility Methods

    /**
     * Clean log files
     */
    cleanLogs(includeCategory = false): void {
        if (!this.logsInitialized || !fs.existsSync(this.config.logsDir)) return

        const files = fs.readdirSync(this.config.logsDir)
        for (const file of files) {
            if (file.startsWith("category_") && !includeCategory) {
                continue
            }
            try {
                fs.rmSync(path.join(this.config.logsDir, file), { force: true })
            } catch {
                // Ignore errors
            }
        }
    }

    /**
     * Get all available categories
     */
    static getCategories(): LogCategory[] {
        return [
            "CORE",
            "NETWORK",
            "PEER",
            "CHAIN",
            "SYNC",
            "CONSENSUS",
            "IDENTITY",
            "MCP",
            "MULTICHAIN",
            "DAHR",
        ]
    }

    /**
     * Get all available levels
     */
    static getLevels(): LogLevel[] {
        return ["debug", "info", "warning", "error", "critical"]
    }
}

// SECTION Default Export - Singleton Instance

/**
 * Default logger instance
 */
const logger = CategorizedLogger.getInstance()

export default logger
