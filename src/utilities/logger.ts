// Defining a log class

import fs from "fs"
import terminalkit from "terminal-kit"
const term = terminalkit.terminal
import sharedState from "./sharedState"

const LOGS_DIR = "logs_" + sharedState.getInstance().serverPort + "_" + sharedState.getInstance().identityFile.replace(".", "")
// Create the logs directory if it doesn't exist
if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true })
}

export default class log {
    static LOG_INFO_FILE = LOGS_DIR + "/info.log"
    static LOG_ERROR_FILE = LOGS_DIR + "/error.log"
    static LOG_DEBUG_FILE = LOGS_DIR + "/debug.log"
    static LOG_WARNING_FILE = LOGS_DIR + "/warning.log"
    static LOG_CRITICAL_FILE = LOGS_DIR + "/critical.log"

    private static getTimestamp(): string {
        return new Date().toISOString()
    }

    static info(message: string) {
        const logEntry = `[INFO] [${this.getTimestamp()}] ${message}\n`
        term.bold(logEntry.trim())
        fs.appendFileSync(this.LOG_INFO_FILE, logEntry)
    }

    static error(message: string) {
        const logEntry = `[ERROR] [${this.getTimestamp()}] ${message}\n`
        term.red(logEntry.trim())
        fs.appendFileSync(this.LOG_ERROR_FILE, logEntry)
    }

    static debug(message: string) {
        const logEntry = `[DEBUG] [${this.getTimestamp()}] ${message}\n`
        term.magenta(logEntry.trim())
        fs.appendFileSync(this.LOG_DEBUG_FILE, logEntry)
    }

    static warning(message: string) {
        const logEntry = `[WARNING] [${this.getTimestamp()}] ${message}\n`
        term.yellow(logEntry.trim())
        fs.appendFileSync(this.LOG_WARNING_FILE, logEntry)
    }

    static critical(message: string) {
                const logEntry = `[CRITICAL] [${this.getTimestamp()}] ${message}\n`
        term.bold.red(logEntry.trim())
        fs.appendFileSync(this.LOG_CRITICAL_FILE, logEntry)
    }

}