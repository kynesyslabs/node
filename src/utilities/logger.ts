// Defining a log class

import sharedState from "src/utilities/sharedState"
import fs from "fs"
import terminalkit from "terminal-kit"
const term = terminalkit.terminal


export default class log {
    static LOGS_DIR = "logs"
    static LOG_INFO_FILE = this.LOGS_DIR + "/info.log"
    static LOG_ERROR_FILE = this.LOGS_DIR + "/error.log"
    static LOG_DEBUG_FILE = this.LOGS_DIR + "/debug.log"
    static LOG_WARNING_FILE = this.LOGS_DIR + "/warning.log"
    static LOG_CRITICAL_FILE = this.LOGS_DIR + "/critical.log"
    static LOG_CUSTOM_PREFIX = this.LOGS_DIR + "/custom_"

    static setLogsDir(port?: number) {
        if (!port) {
            port = sharedState.getInstance().serverPort
        }
        try {
            this.LOGS_DIR =
                "logs_" +
                port +
                "_" +
                sharedState.getInstance().identityFile.replace(".", "")
            // Create the logs directory if it doesn't exist
            if (!fs.existsSync(this.LOGS_DIR)) {
                fs.mkdirSync(this.LOGS_DIR, { recursive: true })
            }
        } catch (error) {
            term.red("Error creating logs directory:", error)
            this.LOGS_DIR = "logs"
        }
        console.log("Logs directory set to:", this.LOGS_DIR)
        this.LOG_INFO_FILE = this.LOGS_DIR + "/info.log"
        this.LOG_ERROR_FILE = this.LOGS_DIR + "/error.log"
        this.LOG_DEBUG_FILE = this.LOGS_DIR + "/debug.log"
        this.LOG_WARNING_FILE = this.LOGS_DIR + "/warning.log"
        this.LOG_CRITICAL_FILE = this.LOGS_DIR + "/critical.log"
        this.LOG_CUSTOM_PREFIX = this.LOGS_DIR + "/custom_"

    }

    private static getTimestamp(): string {
        return new Date().toISOString()
    }

    static custom(
        logfile: string,
        message: string,
        logToTerminal: boolean = true,
        cleanFile: boolean = false,
    ) {
        const logEntry = `[INFO] [${this.getTimestamp()}] ${message}\n`
        if (logToTerminal) {
            term.bold(logEntry.trim())
        }
        if (cleanFile) {
            fs.writeFileSync(this.LOG_CUSTOM_PREFIX + logfile + ".log", "")
        }
        fs.appendFileSync(this.LOG_CUSTOM_PREFIX + logfile + ".log", logEntry)
    }

    static info(message: string, logToTerminal: boolean = true) {
        const logEntry = `[INFO] [${this.getTimestamp()}] ${message}\n`
        if (logToTerminal) {
            term.bold(logEntry.trim() + "\n")
        }
        fs.appendFileSync(this.LOG_INFO_FILE, logEntry)
    }

    static error(message: string, logToTerminal: boolean = true) {
        const logEntry = `[ERROR] [${this.getTimestamp()}] ${message}\n`
        if (logToTerminal) {
            term.red(logEntry.trim() + "\n")
        }
        fs.appendFileSync(this.LOG_INFO_FILE, logEntry)
        fs.appendFileSync(this.LOG_ERROR_FILE, logEntry)
    }

    static debug(message: string, logToTerminal: boolean = true) {
        const logEntry = `[DEBUG] [${this.getTimestamp()}] ${message}\n`
        if (logToTerminal) {
            term.magenta(logEntry.trim() + "\n")
        }
        fs.appendFileSync(this.LOG_INFO_FILE, logEntry)
        fs.appendFileSync(this.LOG_DEBUG_FILE, logEntry)
    }

    static warning(message: string, logToTerminal: boolean = true) {
        const logEntry = `[WARNING] [${this.getTimestamp()}] ${message}\n`
        if (logToTerminal) {
            term.yellow(logEntry.trim() + "\n")
        }
        fs.appendFileSync(this.LOG_INFO_FILE, logEntry)
        fs.appendFileSync(this.LOG_WARNING_FILE, logEntry)
    }

    static critical(message: string, logToTerminal: boolean = true) {
        const logEntry = `[CRITICAL] [${this.getTimestamp()}] ${message}\n`
        if (logToTerminal) {
            term.bold.red(logEntry.trim() + "\n")
        }
        fs.appendFileSync(this.LOG_INFO_FILE, logEntry)
        fs.appendFileSync(this.LOG_CRITICAL_FILE, logEntry)
    }
}
