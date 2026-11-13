import { afterEach, describe, expect, it } from "bun:test"
import path from "node:path"
import { loadConfig } from "./loader"
import { nodeLogsDir } from "src/utilities/tui/LegacyLoggerAdapter"

const KEY = "LOGS_DIR"
const saved = process.env[KEY]

afterEach(() => {
    if (saved === undefined) delete process.env[KEY]
    else process.env[KEY] = saved
})

describe("node logs directory", () => {
    it("is empty when unset, so logs stay in the working directory", () => {
        delete process.env[KEY]
        const base = loadConfig().core.logsDir
        expect(base).toBe("")
        expect(nodeLogsDir(base, 53550, "demos_identity")).toBe(
            "logs_53550_demos_identity",
        )
    })

    it("treats an empty value as unset", () => {
        process.env[KEY] = ""
        expect(loadConfig().core.logsDir).toBe("")
    })

    it("puts the per-node directory inside the configured one, so a logs volume receives it", () => {
        process.env[KEY] = "/app/logs"
        const base = loadConfig().core.logsDir
        expect(base).toBe("/app/logs")
        expect(nodeLogsDir(base, 53550, "demos_identity")).toBe(
            path.join("/app/logs", "logs_53550_demos_identity"),
        )
    })
})
