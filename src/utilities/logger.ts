// Defining a log class

import fs from "fs"
import terminalkit from "terminal-kit"
const term = terminalkit.terminal


export default class log {

    static LOG_INFO_FILE = "logs/info.log"
    static LOG_ERROR_FILE = "logs/error.log"
    static LOG_DEBUG_FILE = "logs/debug.log"
    static LOG_WARNING_FILE = "logs/warning.log"
    static LOG_CRITICAL_FILE = "logs/critical.log"

    private static getTimestamp(): string {
        return new Date().toISOString()
    }

    static info(message: string) {
        const logEntry = `[${this.getTimestamp()}] [INFO] ${message}\n`
        term.bold(logEntry.trim())
        fs.appendFileSync(this.LOG_INFO_FILE, logEntry)
    }

    static error(message: string) {
        const logEntry = `[${this.getTimestamp()}] [ERROR] ${message}\n`
        term.red(logEntry.trim())
        fs.appendFileSync(this.LOG_ERROR_FILE, logEntry)
    }

    static debug(message: string) {
        const logEntry = `[${this.getTimestamp()}] [DEBUG] ${message}\n`
        term.magenta(logEntry.trim())
        fs.appendFileSync(this.LOG_DEBUG_FILE, logEntry)
    }

    static warning(message: string) {
        const logEntry = `[${this.getTimestamp()}] [WARNING] ${message}\n`
        term.yellow(logEntry.trim())
        fs.appendFileSync(this.LOG_WARNING_FILE, logEntry)
    }

    static critical(message: string) {
        const logEntry = `[${this.getTimestamp()}] [CRITICAL] ${message}\n`
        term.bold.red(logEntry.trim())
        fs.appendFileSync(this.LOG_CRITICAL_FILE, logEntry)
    }

}