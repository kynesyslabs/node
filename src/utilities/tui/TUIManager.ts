/**
 * TUIManager - Main orchestrator for the Terminal User Interface
 *
 * Manages the overall TUI layout, keyboard input, and coordinates
 * between all panel components.
 */

import terminalKit from "terminal-kit"
import { EventEmitter } from "events"
import { CategorizedLogger, LogCategory, LogEntry } from "./CategorizedLogger"
import { TAG_TO_CATEGORY } from "./tagCategories"
import { getSharedState } from "@/utilities/sharedState"
import { PeerManager } from "@/libs/peer"

const term = terminalKit.terminal

// SECTION Types

export interface NodeInfo {
    version: string
    status: "starting" | "running" | "syncing" | "stopped" | "error"
    publicKey: string
    port: number
    peersCount: number
    blockNumber: number
    isSynced: boolean
}

export interface TUIConfig {
    /** Refresh rate in milliseconds (default: 100) */
    refreshRate?: number
    /** Show debug info in footer (default: false) */
    debugMode?: boolean
}

// SECTION Layout Constants

const HEADER_HEIGHT = 11 // Expanded to fit logo
const TAB_HEIGHT = 1
const FOOTER_HEIGHT = 2

// SECTION Logo (from res/demos_logo_ascii_bn_xsmall)
const DEMOS_LOGO = [
    "████████████████████",
    "██████     █████████",
    "████ ████  █████████",
    "███ █████ █  ███████",
    "██  ████ █     █████",
    "██       █      ████",
    "███     █ ████  ████",
    "█████  ██ ████  ████",
    "████████ ████  █████",
    "███████      ███████",
    "████████████████████",
]

// SECTION Color Schemes

const COLORS = {
    // Status colors
    statusRunning: "green",
    statusSyncing: "yellow",
    statusStopped: "red",
    statusError: "brightRed",

    // Log level colors
    logDebug: "magenta",
    logInfo: "white",
    logWarning: "yellow",
    logError: "red",
    logCritical: "brightRed",

    // UI colors
    border: "cyan",
    header: "brightCyan",
    tabActive: "brightWhite",
    tabInactive: "gray",
    footer: "gray",
    footerKey: "brightYellow",
}

// SECTION Tab Definitions

interface Tab {
    key: string
    label: string
    category: LogCategory | "ALL" | "CMD"
}

const TABS: Tab[] = [
    { key: "0", label: "All", category: "ALL" },
    { key: "1", label: "Core", category: "CORE" },
    { key: "2", label: "Net", category: "NETWORK" },
    { key: "3", label: "Peer", category: "PEER" },
    { key: "4", label: "Chain", category: "CHAIN" },
    { key: "5", label: "Sync", category: "SYNC" },
    { key: "6", label: "Cons", category: "CONSENSUS" },
    { key: "7", label: "ID", category: "IDENTITY" },
    { key: "8", label: "MCP", category: "MCP" },
    { key: "9", label: "XM", category: "MULTICHAIN" },
    { key: "-", label: "DAHR", category: "DAHR" },
    { key: "=", label: "CMD", category: "CMD" },
]

// SECTION Command definitions for CMD tab
interface Command {
    name: string
    description: string
    handler: (args: string[], tui: TUIManager) => void
}

const COMMANDS: Command[] = [
    {
        name: "help",
        description: "Show available commands",
        handler: (_args, tui) => {
            tui.addCmdOutput("=== Available Commands ===")
            COMMANDS.forEach(cmd => {
                tui.addCmdOutput(`  ${cmd.name.padEnd(12)} - ${cmd.description}`)
            })
            tui.addCmdOutput("==========================")
        },
    },
    {
        name: "quit",
        description: "Exit the node",
        handler: (_args, tui) => {
            tui.addCmdOutput("Shutting down...")
            setTimeout(() => {
                tui.emit("quit")
                tui.stop()
                process.exit(0)
            }, 500)
        },
    },
    {
        name: "clear",
        description: "Clear command output",
        handler: (_args, tui) => {
            tui.clearCmdOutput()
        },
    },
    {
        name: "status",
        description: "Show node status",
        handler: (_args, tui) => {
            const info = tui.getNodeInfo()
            tui.addCmdOutput("=== Node Status ===")
            tui.addCmdOutput(`  Version:   ${info.version}`)
            tui.addCmdOutput(`  Status:    ${info.status}`)
            tui.addCmdOutput(`  Port:      ${info.port}`)
            tui.addCmdOutput(`  Peers:     ${info.peersCount}`)
            tui.addCmdOutput(`  Block:     #${info.blockNumber}`)
            tui.addCmdOutput(`  Synced:    ${info.isSynced ? "Yes" : "No"}`)
            tui.addCmdOutput(`  PubKey:    ${info.publicKey}`)
            tui.addCmdOutput("===================")
        },
    },
    {
        name: "peers",
        description: "Show connected peers",
        handler: (_args, tui) => {
            tui.addCmdOutput("Peers: (emit command to main app)")
            tui.emit("command", "peers")
        },
    },
    {
        name: "sync",
        description: "Force sync with network",
        handler: (_args, tui) => {
            tui.addCmdOutput("Requesting sync...")
            tui.emit("command", "sync")
        },
    },
]

// SECTION Main TUIManager Class

export class TUIManager extends EventEmitter {
    private static instance: TUIManager | null = null

    private logger: CategorizedLogger
    private config: Required<TUIConfig>
    private nodeInfo: NodeInfo
    private activeTabIndex = 0
    private scrollOffsets: Map<string, number> = new Map() // Per-tab scroll positions
    private autoScroll = true
    private isRunning = false
    private refreshInterval: NodeJS.Timeout | null = null

    // Screen dimensions
    private width = 0
    private height = 0
    private logAreaHeight = 0

    // Filtered logs cache
    private filteredLogs: LogEntry[] = []

    // CMD tab state
    private cmdInput = ""
    private cmdOutput: string[] = []
    private cmdHistory: string[] = []
    private cmdHistoryIndex = -1
    private isCmdMode = false

    private constructor(config: TUIConfig = {}) {
        super()
        this.config = {
            refreshRate: config.refreshRate ?? 100,
            debugMode: config.debugMode ?? false,
        }

        this.logger = CategorizedLogger.getInstance()

        this.nodeInfo = {
            version: "1.0.0",
            status: "starting",
            publicKey: "",
            port: 0,
            peersCount: 0,
            blockNumber: 0,
            isSynced: false,
        }

        // Subscribe to log events
        this.logger.on("log", this.handleLogEntry.bind(this))
    }

    /**
     * Get singleton instance
     */
    static getInstance(config?: TUIConfig): TUIManager {
        if (!TUIManager.instance) {
            TUIManager.instance = new TUIManager(config)
        }
        return TUIManager.instance
    }

    /**
     * Reset instance (for testing)
     */
    static resetInstance(): void {
        if (TUIManager.instance) {
            TUIManager.instance.stop()
            TUIManager.instance = null
        }
    }

    // SECTION Lifecycle Methods

    // Store original console methods for restoration
    private originalConsole: {
        log: typeof console.log
        error: typeof console.error
        warn: typeof console.warn
        info: typeof console.info
        debug: typeof console.debug
    } | null = null

    /**
     * Start the TUI
     */
    async start(): Promise<void> {
        if (this.isRunning) return

        this.isRunning = true

        // Enable TUI mode in logger (suppress direct terminal output)
        this.logger.enableTuiMode()

        // Intercept all console output to prevent external libs from corrupting TUI
        this.interceptConsole()

        // Get initial dimensions
        this.updateDimensions()

        // Setup terminal
        term.fullscreen(true)
        term.hideCursor()
        term.grabInput({ mouse: "button" })

        // Setup event handlers
        this.setupInputHandlers()
        this.setupResizeHandler()

        // Initial render
        this.updateFilteredLogs()
        this.render()

        // Start refresh loop
        this.refreshInterval = setInterval(() => {
            this.render()
        }, this.config.refreshRate)

        this.emit("started")
    }

    /**
     * Stop the TUI and restore terminal
     */
    stop(): void {
        if (!this.isRunning) return

        this.isRunning = false

        // Stop refresh loop
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval)
            this.refreshInterval = null
        }

        // Restore console methods before terminal restore
        this.restoreConsole()

        // Restore terminal
        term.grabInput(false)
        term.hideCursor(false)
        term.fullscreen(false)
        term.styleReset()
        term.clear()

        // Disable TUI mode in logger
        this.logger.disableTuiMode()

        this.emit("stopped")
    }

    /**
     * Extract tag from message and infer category using shared TAG_TO_CATEGORY mapping
     */
    private extractCategoryFromMessage(message: string): { category: LogCategory; cleanMessage: string } {
        // Try to extract tag from message like "[PeerManager] ..."
        const match = message.match(/^\[([A-Za-z0-9_ ]+)\]\s*(.*)$/i)
        if (match) {
            const tag = match[1].toUpperCase()
            const cleanMessage = match[2]
            const category = TAG_TO_CATEGORY[tag] ?? "CORE"
            return { category, cleanMessage }
        }

        return { category: "CORE", cleanMessage: message }
    }

    /**
     * Intercept console methods to route through TUI logger
     * This prevents external libraries from corrupting the TUI display
     */
    private interceptConsole(): void {
        // Prevent double-interception
        if (this.originalConsole) return

        // Store original methods
        this.originalConsole = {
            log: console.log,
            error: console.error,
            warn: console.warn,
            info: console.info,
            debug: console.debug,
        }

        // Replace with TUI-safe versions that route to the logger with category detection
        console.log = (...args: unknown[]) => {
            const message = args.map(a => String(a)).join(" ")
            const { category, cleanMessage } = this.extractCategoryFromMessage(message)
            this.logger.debug(category, `[console.log] ${cleanMessage}`)
        }

        console.error = (...args: unknown[]) => {
            const message = args.map(a => String(a)).join(" ")
            const { category, cleanMessage } = this.extractCategoryFromMessage(message)
            this.logger.error(category, `[console.error] ${cleanMessage}`)
        }

        console.warn = (...args: unknown[]) => {
            const message = args.map(a => String(a)).join(" ")
            const { category, cleanMessage } = this.extractCategoryFromMessage(message)
            this.logger.warning(category, `[console.warn] ${cleanMessage}`)
        }

        console.info = (...args: unknown[]) => {
            const message = args.map(a => String(a)).join(" ")
            const { category, cleanMessage } = this.extractCategoryFromMessage(message)
            this.logger.info(category, `[console.info] ${cleanMessage}`)
        }

        console.debug = (...args: unknown[]) => {
            const message = args.map(a => String(a)).join(" ")
            const { category, cleanMessage } = this.extractCategoryFromMessage(message)
            this.logger.debug(category, `[console.debug] ${cleanMessage}`)
        }
    }

    /**
     * Restore original console methods
     */
    private restoreConsole(): void {
        if (this.originalConsole) {
            console.log = this.originalConsole.log
            console.error = this.originalConsole.error
            console.warn = this.originalConsole.warn
            console.info = this.originalConsole.info
            console.debug = this.originalConsole.debug
            this.originalConsole = null
        }
    }

    /**
     * Check if TUI is running
     */
    getIsRunning(): boolean {
        return this.isRunning
    }

    // SECTION Dimension Management

    /**
     * Update screen dimensions
     */
    private updateDimensions(): void {
        this.width = term.width
        this.height = term.height
        this.logAreaHeight = this.height - HEADER_HEIGHT - TAB_HEIGHT - FOOTER_HEIGHT
    }

    // SECTION Input Handling

    /**
     * Setup keyboard and mouse input handlers
     */
    private setupInputHandlers(): void {
        term.on("key", (key: string) => {
            this.handleKeyPress(key)
        })
    }

    /**
     * Handle keyboard input
     */
    private handleKeyPress(key: string): void {
        // If in CMD mode, handle command input
        if (this.isCmdMode) {
            this.handleCmdInput(key)
            return
        }

        switch (key) {
            // Quit
            case "q":
            case "Q":
            case "CTRL_C":
                this.handleQuit()
                break

            // Tab switching with number keys
            case "0":
            case "1":
            case "2":
            case "3":
            case "4":
            case "5":
            case "6":
            case "7":
            case "8":
            case "9":
                this.setActiveTab(parseInt(key))
                break

            case "-":
                this.setActiveTab(10) // DAHR tab
                break

            case "=":
                this.setActiveTab(11) // CMD tab
                break

            // Tab navigation
            case "TAB":
            case "RIGHT":
                this.nextTab()
                break

            case "SHIFT_TAB":
            case "LEFT":
                this.previousTab()
                break

            // Scrolling
            case "UP":
            case "k":
                this.scrollUp()
                break

            case "DOWN":
            case "j":
                this.scrollDown()
                break

            case "PAGE_UP":
                this.scrollPageUp()
                break

            case "PAGE_DOWN":
                this.scrollPageDown()
                break

            case "HOME":
                this.scrollToTop()
                break

            case "END":
                this.scrollToBottom()
                break

            // Toggle auto-scroll
            case "a":
            case "A":
                this.toggleAutoScroll()
                break

            // Clear logs
            case "c":
            case "C":
                this.clearLogs()
                break

            // Help
            case "h":
            case "H":
            case "?":
                this.showHelp()
                break

            // Controls (emit events for main app to handle)
            case "s":
            case "S":
                this.emit("command", "start")
                break

            case "p":
            case "P":
                this.emit("command", "pause")
                break

            case "r":
            case "R":
                this.emit("command", "restart")
                break
        }
    }

    /**
     * Handle CMD tab input
     */
    private handleCmdInput(key: string): void {
        switch (key) {
            case "ESCAPE":
                // Exit CMD mode without executing
                this.isCmdMode = false
                this.cmdInput = ""
                this.render()
                break

            case "ENTER":
                // Execute command
                this.executeCommand(this.cmdInput)
                if (this.cmdInput.trim()) {
                    this.cmdHistory.push(this.cmdInput)
                    if (this.cmdHistory.length > 100) { // Limit history size
                        this.cmdHistory.shift()
                    }
                }
                this.cmdHistoryIndex = this.cmdHistory.length
                this.cmdInput = ""
                this.render()
                break

            case "BACKSPACE":
                // Delete last character
                this.cmdInput = this.cmdInput.slice(0, -1)
                this.render()
                break

            case "UP":
                // Previous command in history
                if (this.cmdHistoryIndex > 0) {
                    this.cmdHistoryIndex--
                    this.cmdInput = this.cmdHistory[this.cmdHistoryIndex] || ""
                    this.render()
                }
                break

            case "DOWN":
                // Next command in history
                if (this.cmdHistoryIndex < this.cmdHistory.length - 1) {
                    this.cmdHistoryIndex++
                    this.cmdInput = this.cmdHistory[this.cmdHistoryIndex] || ""
                } else {
                    this.cmdHistoryIndex = this.cmdHistory.length
                    this.cmdInput = ""
                }
                this.render()
                break

            case "CTRL_C":
                // Exit CMD mode or quit
                if (this.cmdInput.length > 0) {
                    this.cmdInput = ""
                    this.render()
                } else {
                    this.handleQuit()
                }
                break

            default:
                // Add character to input (only printable characters)
                if (key.length === 1 && key.charCodeAt(0) >= 32) {
                    this.cmdInput += key
                    this.render()
                }
                break
        }
    }

    /**
     * Execute a command
     */
    private executeCommand(input: string): void {
        const trimmed = input.trim()
        if (!trimmed) return

        // Add to output
        this.addCmdOutput(`> ${trimmed}`)

        // Parse command and args
        const parts = trimmed.split(/\s+/)
        const cmdName = parts[0].toLowerCase()
        const args = parts.slice(1)

        // Find and execute command
        const cmd = COMMANDS.find(c => c.name === cmdName)
        if (cmd) {
            cmd.handler(args, this)
        } else {
            this.addCmdOutput(`Unknown command: ${cmdName}`)
            this.addCmdOutput("Type 'help' for available commands")
        }
    }

    /**
     * Add output to CMD tab
     */
    addCmdOutput(line: string): void {
        this.cmdOutput.push(line)
        // Keep only last 500 lines
        if (this.cmdOutput.length > 500) {
            this.cmdOutput = this.cmdOutput.slice(-500)
        }
    }

    /**
     * Clear CMD output
     */
    clearCmdOutput(): void {
        this.cmdOutput = []
    }

    /**
     * Handle quit request - stop TUI and exit process
     */
    private handleQuit(): void {
        this.emit("quit")
        this.stop()
        process.exit(0)
    }

    /**
     * Setup terminal resize handler
     */
    private setupResizeHandler(): void {
        term.on("resize", (width: number, height: number) => {
            this.width = width
            this.height = height
            this.logAreaHeight = this.height - HEADER_HEIGHT - TAB_HEIGHT - FOOTER_HEIGHT
            this.render()
        })
    }

    // SECTION Tab Management

    /**
     * Get current tab's scroll offset
     */
    private getScrollOffset(): number {
        const tab = this.getActiveTab()
        return this.scrollOffsets.get(tab.category) ?? 0
    }

    /**
     * Set current tab's scroll offset
     */
    private setScrollOffset(offset: number): void {
        const tab = this.getActiveTab()
        this.scrollOffsets.set(tab.category, offset)
    }

    /**
     * Set active tab by index
     */
    setActiveTab(index: number): void {
        if (index >= 0 && index < TABS.length) {
            this.activeTabIndex = index

            // Check if CMD tab
            const tab = TABS[index]
            if (tab.category === "CMD") {
                this.isCmdMode = true
                // Show welcome message on first access
                if (this.cmdOutput.length === 0) {
                    this.cmdOutput = [
                        "╔═══════════════════════════════════════════╗",
                        "║       DEMOS NODE COMMAND TERMINAL         ║",
                        "╚═══════════════════════════════════════════╝",
                        "",
                        "Type 'help' for available commands.",
                        "Press ESC to return to log view.",
                        "",
                    ]
                }
            } else {
                this.isCmdMode = false
                this.updateFilteredLogs()
            }
            this.render()
        }
    }

    /**
     * Move to next tab
     */
    nextTab(): void {
        this.setActiveTab((this.activeTabIndex + 1) % TABS.length)
    }

    /**
     * Move to previous tab
     */
    previousTab(): void {
        this.setActiveTab((this.activeTabIndex - 1 + TABS.length) % TABS.length)
    }

    /**
     * Get current active tab
     */
    getActiveTab(): Tab {
        return TABS[this.activeTabIndex]
    }

    // SECTION Scroll Management

    /**
     * Scroll up one line
     */
    scrollUp(): void {
        this.autoScroll = false
        const currentOffset = this.getScrollOffset()
        if (currentOffset > 0) {
            this.setScrollOffset(currentOffset - 1)
            this.render()
        }
    }

    /**
     * Scroll down one line
     */
    scrollDown(): void {
        const maxScroll = Math.max(0, this.filteredLogs.length - this.logAreaHeight)
        const currentOffset = this.getScrollOffset()
        if (currentOffset < maxScroll) {
            this.setScrollOffset(currentOffset + 1)
            this.render()
        }
    }

    /**
     * Scroll up one page
     */
    scrollPageUp(): void {
        this.autoScroll = false
        const currentOffset = this.getScrollOffset()
        this.setScrollOffset(Math.max(0, currentOffset - this.logAreaHeight))
        this.render()
    }

    /**
     * Scroll down one page
     */
    scrollPageDown(): void {
        const maxScroll = Math.max(0, this.filteredLogs.length - this.logAreaHeight)
        const currentOffset = this.getScrollOffset()
        this.setScrollOffset(Math.min(maxScroll, currentOffset + this.logAreaHeight))
        this.render()
    }

    /**
     * Scroll to top
     */
    scrollToTop(): void {
        this.autoScroll = false
        this.setScrollOffset(0)
        this.render()
    }

    /**
     * Scroll to bottom
     */
    scrollToBottom(): void {
        this.autoScroll = true
        const maxScroll = Math.max(0, this.filteredLogs.length - this.logAreaHeight)
        this.setScrollOffset(maxScroll)
        this.render()
    }

    /**
     * Toggle auto-scroll
     */
    toggleAutoScroll(): void {
        this.autoScroll = !this.autoScroll
        if (this.autoScroll) {
            this.scrollToBottom()
        }
        this.render()
    }

    // SECTION Log Management

    /**
     * Handle new log entry
     */
    private handleLogEntry(_entry: LogEntry): void {
        this.updateFilteredLogs()

        // Auto-scroll to bottom if enabled
        if (this.autoScroll) {
            const maxScroll = Math.max(0, this.filteredLogs.length - this.logAreaHeight)
            this.setScrollOffset(maxScroll)
        }
    }

    /**
     * Update filtered logs based on active tab
     */
    private updateFilteredLogs(): void {
        const activeTab = TABS[this.activeTabIndex]

        if (activeTab.category === "ALL") {
            this.filteredLogs = this.logger.getAllEntries()
        } else {
            this.filteredLogs = this.logger.getEntriesByCategory(activeTab.category)
        }
    }

    /**
     * Clear logs
     */
    clearLogs(): void {
        this.logger.clearBuffer()
        this.filteredLogs = []
        // Reset all tab scroll offsets
        this.scrollOffsets.clear()
        this.render()
    }

    // SECTION Node Info Updates

    /**
     * Update node information
     */
    updateNodeInfo(info: Partial<NodeInfo>): void {
        this.nodeInfo = { ...this.nodeInfo, ...info }
    }

    /**
     * Get current node info
     */
    getNodeInfo(): NodeInfo {
        return { ...this.nodeInfo }
    }

    /**
     * Check if we're running in standalone mode (no real peers to sync with)
     * Returns true if: no peers, or only localhost/127.0.0.1 peers
     */
    private checkIfStandalone(): boolean {
        try {
            const peers = PeerManager.getInstance().getPeers()
            if (peers.length === 0) return true

            // Check if all peers are localhost
            const nonLocalPeers = peers.filter(peer => {
                const connStr = peer.connection?.string?.toLowerCase() || ""
                return !connStr.includes("localhost") && !connStr.includes("127.0.0.1")
            })

            return nonLocalPeers.length === 0
        } catch {
            // If we can't get peers, assume standalone
            return true
        }
    }

    // SECTION Rendering

    /**
     * Main render function - uses partial updates to avoid flashing
     */
    render(): void {
        if (!this.isRunning) return

        // Render components (each clears its own area)
        this.renderHeader()
        this.renderTabs()

        // Render content area based on mode
        if (this.isCmdMode) {
            this.renderCmdArea()
        } else {
            this.renderLogArea()
        }

        this.renderFooter()
    }

    /**
     * Render header panel with logo and node info
     */
    private renderHeader(): void {
        const statusIcon = this.getStatusIcon()
        const logoWidth = 22 // Logo width + padding
        const infoStartX = logoWidth + 2

        // Render logo on the left (11 lines)
        for (let i = 0; i < DEMOS_LOGO.length; i++) {
            term.moveTo(1, i + 1)
            term.eraseLine()
            term.cyan(DEMOS_LOGO[i])
        }

        // Line 1: Title and version
        term.moveTo(infoStartX, 1)
        term.bgBrightBlue.white(" ◆ DEMOS NODE ")
        term.bgBlue.white(` v${this.nodeInfo.version} `)

        // Line 2: Status
        term.moveTo(infoStartX, 2)
        switch (this.nodeInfo.status) {
            case "running":
                term.bgGreen.black(` ${statusIcon} RUNNING `)
                break
            case "syncing":
                term.bgYellow.black(` ${statusIcon} SYNCING `)
                break
            case "starting":
                term.bgCyan.black(` ${statusIcon} STARTING `)
                break
            case "stopped":
                term.bgGray.white(` ${statusIcon} STOPPED `)
                break
            case "error":
                term.bgRed.white(` ${statusIcon} ERROR `)
                break
        }

        // Line 3: Separator
        term.moveTo(infoStartX, 3)
        term.cyan("─".repeat(this.width - infoStartX))

        // Line 4: Public key (show full if fits, otherwise truncate with first 4...last 4)
        term.moveTo(infoStartX, 4)
        term.yellow("🔑 ")
        term.gray("Identity: ")
        const availableWidth = this.width - infoStartX - 15 // Account for emoji + "Identity: "
        let keyDisplay = "Loading..."
        if (this.nodeInfo.publicKey) {
            if (this.nodeInfo.publicKey.length <= availableWidth) {
                keyDisplay = this.nodeInfo.publicKey
            } else {
                // Show first 4 and last 4 characters
                keyDisplay = `${this.nodeInfo.publicKey.slice(0, 4)}...${this.nodeInfo.publicKey.slice(-4)}`
            }
        }
        term.brightWhite(keyDisplay)

        // Line 5: Empty separator
        term.moveTo(infoStartX, 5)

        // Line 6: Port
        term.moveTo(infoStartX, 6)
        term.yellow("📡 ")
        term.gray("Port: ")
        term.brightWhite(String(this.nodeInfo.port))

        // Line 7: Peers (read live from PeerManager)
        term.moveTo(infoStartX, 7)
        term.yellow("👥 ")
        term.gray("Peers: ")
        let livePeersCount = 0
        try {
            livePeersCount = PeerManager.getInstance().getPeers().length
        } catch {
            livePeersCount = this.nodeInfo.peersCount
        }
        term.brightWhite(String(livePeersCount))

        // Line 8: Block (read live from sharedState)
        term.moveTo(infoStartX, 8)
        term.yellow("📦 ")
        term.gray("Block: ")
        const liveBlockNumber = getSharedState.lastBlockNumber ?? this.nodeInfo.blockNumber
        term.brightWhite("#" + String(liveBlockNumber))

        // Line 9: Sync status (read live from sharedState)
        term.moveTo(infoStartX, 9)
        term.yellow("🔄 ")
        term.gray("Sync: ")
        const liveSyncStatus = getSharedState.syncStatus
        const isStandalone = this.checkIfStandalone()
        if (liveSyncStatus) {
            term.bgGreen.black(" ✓ SYNCED ")
        } else if (isStandalone) {
            // Only localhost peer or no peers - we're standalone
            term.bgCyan.black(" ◆ STANDALONE ")
        } else {
            term.bgYellow.black(" ... SYNCING ")
        }

        // Line 10: Auto-scroll indicator
        term.moveTo(infoStartX, 10)
        term.yellow("📜 ")
        term.gray("Scroll: ")
        if (this.autoScroll) {
            term.green("[▼ AUTO]")
        } else {
            term.gray("[█ MANUAL]")
        }

        // Line 11: Separator before tabs
        term.moveTo(infoStartX, 11)
        term.cyan("─".repeat(this.width - infoStartX))
    }

    /**
     * Render tab bar with improved styling
     */
    private renderTabs(): void {
        const y = HEADER_HEIGHT + 1

        term.moveTo(1, y)
        term.eraseLine()

        // Tab bar background
        term.bgGray(" ")

        for (let i = 0; i < TABS.length; i++) {
            const tab = TABS[i]
            const isActive = i === this.activeTabIndex

            if (isActive) {
                // Active tab with highlight
                term.bgBrightWhite.black(` ${tab.key}`)
                term.bgBrightWhite.brightBlue(`:${tab.label} `)
            } else {
                // Inactive tab
                term.bgGray.brightYellow(` ${tab.key}`)
                term.bgGray.white(`:${tab.label} `)
            }
        }

        // Fill rest of line with tab bar background
        const tabsWidth = TABS.reduce((acc, t) => acc + t.key.length + t.label.length + 3, 0) + 1
        if (tabsWidth < this.width) {
            term.bgGray(" ".repeat(this.width - tabsWidth))
        }
    }

    /**
     * Render log area
     */
    private renderLogArea(): void {
        const startY = HEADER_HEIGHT + TAB_HEIGHT + 1
        const currentOffset = this.getScrollOffset()

        // Get visible logs
        const visibleLogs = this.filteredLogs.slice(
            currentOffset,
            currentOffset + this.logAreaHeight,
        )

        for (let i = 0; i < this.logAreaHeight; i++) {
            const y = startY + i
            term.moveTo(1, y)
            term.eraseLine()

            if (i < visibleLogs.length) {
                const entry = visibleLogs[i]
                this.renderLogEntry(entry)
            }
            // Empty lines are already cleared by eraseLine
        }

        // Scroll indicator
        if (this.filteredLogs.length > this.logAreaHeight) {
            const maxScroll = this.filteredLogs.length - this.logAreaHeight
            const scrollPercent = maxScroll > 0
                ? Math.round((currentOffset / maxScroll) * 100)
                : 0
            term.moveTo(this.width - 5, startY)
            term.gray(`${scrollPercent}%`)
        }
    }

    /**
     * Render a single log entry with improved styling
     */
    private renderLogEntry(entry: LogEntry): void {
        // Timestamp with muted style
        const time = entry.timestamp.toISOString().split("T")[1].slice(0, 8)
        term.gray(`${time} `)

        // Level with icon and colored background
        const levelIcons: Record<string, string> = {
            debug: "🔍",
            info: "ℹ️ ",
            warning: "⚠️ ",
            error: "❌",
            critical: "🔥",
        }
        const icon = levelIcons[entry.level] || "  "

        switch (entry.level) {
            case "debug":
                term.bgMagenta.white(` ${icon} `)
                break
            case "info":
                term.bgBlue.white(` ${icon} `)
                break
            case "warning":
                term.bgYellow.black(` ${icon} `)
                break
            case "error":
                term.bgRed.white(` ${icon} `)
                break
            case "critical":
                term.bgBrightRed.white(` ${icon} `)
                break
        }

        // Category with bracket styling
        term.cyan(" [")
        term.brightCyan(entry.category.padEnd(10))
        term.cyan("] ")

        // Message (truncate if too long)
        const prefixLen = 9 + 4 + 14 + 1 // time + icon/level + category + spaces
        const maxMsgLen = this.width - prefixLen - 1
        const msg = entry.message.length > maxMsgLen
            ? entry.message.slice(0, maxMsgLen - 3) + "..."
            : entry.message

        // Color message based on level
        switch (entry.level) {
            case "debug":
                term.gray(msg)
                break
            case "info":
                term.white(msg)
                break
            case "warning":
                term.yellow(msg)
                break
            case "error":
                term.red(msg)
                break
            case "critical":
                term.brightRed(msg)
                break
        }
    }

    /**
     * Render CMD area (command terminal)
     */
    private renderCmdArea(): void {
        const startY = HEADER_HEIGHT + TAB_HEIGHT + 1
        const inputLineY = this.height - FOOTER_HEIGHT - 1  // One line above footer for input

        // Calculate available lines for output (minus 1 for input line)
        const outputAreaHeight = this.logAreaHeight - 1

        // Get visible output lines (show most recent)
        const visibleOutput = this.cmdOutput.slice(-outputAreaHeight)

        // Render output lines
        for (let i = 0; i < outputAreaHeight; i++) {
            const y = startY + i
            term.moveTo(1, y)
            term.eraseLine()

            if (i < visibleOutput.length) {
                const line = visibleOutput[i]
                // Colorize special output
                if (line.startsWith(">")) {
                    term.cyan(line)
                } else if (line.startsWith("===") || line.startsWith("╔") || line.startsWith("║") || line.startsWith("╚")) {
                    term.brightCyan(line)
                } else if (line.startsWith("  ")) {
                    term.white(line)
                } else if (line.includes("error") || line.includes("Unknown")) {
                    term.red(line)
                } else {
                    term.gray(line)
                }
            }
        }

        // Render input line with prompt
        term.moveTo(1, inputLineY)
        term.eraseLine()
        term.brightGreen("demos> ")
        term.white(this.cmdInput)

        // Show cursor position
        term.moveTo(8 + this.cmdInput.length, inputLineY)
        term.brightWhite("█")
    }

    /**
     * Render footer panel with improved styling
     */
    private renderFooter(): void {
        const y1 = this.height - 1
        const y2 = this.height

        // Line 1: Controls bar
        term.moveTo(1, y1)
        term.eraseLine()

        // Different footer for CMD mode
        if (this.isCmdMode) {
            term.bgBlue.white(" 📟 COMMAND MODE ")
            term.bgGray.black(" ")
            term.bgGray.brightYellow("Enter")
            term.bgGray.black(":execute ")
            term.bgGray.brightYellow("↑↓")
            term.bgGray.black(":history ")
            term.bgGray.brightYellow("ESC")
            term.bgGray.black(":back ")
            term.bgGray.brightYellow("Ctrl+C")
            term.bgGray.black(":clear/quit ")

            // Fill rest
            const cmdLen = 70
            if (cmdLen < this.width) {
                term.bgGray(" ".repeat(this.width - cmdLen))
            }
        } else {
            term.bgBlue.white(" ⌨ CONTROLS ")
            term.bgGray.black(" ")
            term.bgGray.brightCyan("[S]")
            term.bgGray.white("tart ")
            term.bgGray.brightCyan("[P]")
            term.bgGray.white("ause ")
            term.bgGray.brightCyan("[R]")
            term.bgGray.white("estart ")
            term.bgGray.brightRed("[Q]")
            term.bgGray.white("uit ")
            term.bgGray.black("│ ")
            term.bgGray.brightGreen("[A]")
            term.bgGray.white("uto ")
            term.bgGray.brightYellow("[C]")
            term.bgGray.white("lear ")
            term.bgGray.brightMagenta("[H]")
            term.bgGray.white("elp ")

            // Fill rest of footer line 1
            const controlsLen = 80 // approximate
            if (controlsLen < this.width) {
                term.bgGray(" ".repeat(this.width - controlsLen))
            }
        }

        // Line 2: Navigation hints with styled separators
        term.moveTo(1, y2)
        term.eraseLine()
        term.bgBlack(" ")
        term.bgBlack.cyan("↑↓")
        term.bgBlack.gray("/")
        term.bgBlack.cyan("jk")
        term.bgBlack.white(":scroll ")
        term.bgBlack.gray("│ ")
        term.bgBlack.cyan("PgUp/Dn")
        term.bgBlack.white(":page ")
        term.bgBlack.gray("│ ")
        term.bgBlack.cyan("Home/End")
        term.bgBlack.white(":top/bot ")
        term.bgBlack.gray("│ ")
        term.bgBlack.brightYellow("0-9")
        term.bgBlack.gray(",")
        term.bgBlack.brightYellow("-")
        term.bgBlack.gray(",")
        term.bgBlack.brightYellow("=")
        term.bgBlack.white(":tabs ")
        term.bgBlack.gray("│ ")
        term.bgBlack.cyan("Tab")
        term.bgBlack.white(":next ")

        // Fill rest
        const navLen = 85
        if (navLen < this.width) {
            term.bgBlack(" ".repeat(this.width - navLen))
        }
    }

    /**
     * Show help overlay
     */
    private showHelp(): void {
        // Simple help - could be expanded to a modal
        this.logger.info("CORE", "=== TUI HELP ===")
        this.logger.info("CORE", "Navigation: ↑↓ or j/k to scroll, PgUp/PgDn for pages")
        this.logger.info("CORE", "Tabs: 0-9 or - for categories, Tab to cycle")
        this.logger.info("CORE", "Controls: S=start, P=pause, R=restart, Q=quit")
        this.logger.info("CORE", "Other: A=auto-scroll, C=clear, H=help")
        this.logger.info("CORE", "================")
    }

    // SECTION Helper Methods

    /**
     * Get status icon based on node status
     */
    private getStatusIcon(): string {
        switch (this.nodeInfo.status) {
            case "running":
                return "●"
            case "syncing":
                return "◐"
            case "starting":
                return "○"
            case "stopped":
                return "○"
            case "error":
                return "✖"
            default:
                return "?"
        }
    }

    /**
     * Get status color based on node status
     */
    private getStatusColor(): string {
        switch (this.nodeInfo.status) {
            case "running":
                return "green"
            case "syncing":
                return "yellow"
            case "starting":
                return "cyan"
            case "stopped":
                return "gray"
            case "error":
                return "red"
            default:
                return "white"
        }
    }
}

// SECTION Default Export

export default TUIManager
