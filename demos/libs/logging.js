// INFO This module replaces (or at least superseed) the classic console.log() function.
const term = require("terminal-kit").terminal

let print = {
    log: function (message) {
        term("[INFO]")
        term(message)
        term("\n")
    },
    warn: function (message) {
        term("[WARN]")
        term(message)
        term("\n")
    },
    error: function (message) {
        term("[ERROR]")
        term(message)
        term("\n")
    },
    critical: function (message) {
        term("[CRITICAL]")
        term(message)
        term("\n")
    },
}

module.exports = { print }
