import dotenv from "dotenv"
// NOTE Terminal kit for useful logging
import terminalkit from "terminal-kit"

dotenv.config()

var term = terminalkit.terminal

export default class log {
    constructor() {}

    static getVerbosity(): number {
        try {
            return parseInt(process.env.verbosity)
        } catch (error) {
            return 1
        }
    }

    static info(message: string) {
        if (log.getVerbosity() == 0) {
            console.log("[INFO] " + message)
        }
    }

    static warn(message: string) {
        if (log.getVerbosity() <= 1) {
            term.yellow("[WARN] " + message + "\n")
        }
    }

    static error(message: string) {
        if (log.getVerbosity() <= 2) {
            term.red("[ERROR] " + message + "\n")
        }
    }

    static fatal(message: string, error_code: number = -1) {
        if (log.getVerbosity() <= 3) {
            term.red("[FATAL] " + message + "\n")
            process.exit(error_code)
        }
    }
}
