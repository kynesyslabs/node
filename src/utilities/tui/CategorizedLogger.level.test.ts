import { afterEach, describe, expect, it } from "bun:test"
import { CategorizedLogger, type LogLevel } from "./CategorizedLogger"

const LEVELS: LogLevel[] = ["debug", "info", "warning", "error", "critical"]

function kept(minLevel: LogLevel): LogLevel[] {
    CategorizedLogger.resetInstance()
    const logger = CategorizedLogger.getInstance({ minLevel, terminalOutput: false })
    return LEVELS.filter(level => logger[level]("CORE", `${level} line`) !== null)
}

afterEach(() => CategorizedLogger.resetInstance())

describe("the minimum log level", () => {
    it("keeps every level under debug, the most verbose one", () => {
        expect(kept("debug")).toEqual(LEVELS)
    })

    it("keeps the chosen level and everything more severe", () => {
        expect(kept("info")).toEqual(["info", "warning", "error", "critical"])
        expect(kept("error")).toEqual(["error", "critical"])
        expect(kept("critical")).toEqual(["critical"])
    })
})
