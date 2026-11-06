import { afterEach, describe, expect, it } from "bun:test"
import { loadConfig } from "./loader"
import { diskSpacePath } from "src/utilities/diskSpace"

const KEY = "DISK_SPACE_PATH"
const saved = process.env[KEY]

afterEach(() => {
    if (saved === undefined) delete process.env[KEY]
    else process.env[KEY] = saved
})

describe("disk space path", () => {
    it("measures the working directory when unset", () => {
        delete process.env[KEY]
        expect(loadConfig().diagnostics.diskSpacePath).toBe("")
        expect(diskSpacePath("")).toBe(process.cwd())
    })

    it("measures the configured path, so a data volume on its own disk is the one checked", () => {
        process.env[KEY] = "/app/data"
        expect(loadConfig().diagnostics.diskSpacePath).toBe("/app/data")
        expect(diskSpacePath(loadConfig().diagnostics.diskSpacePath)).toBe("/app/data")
    })
})
