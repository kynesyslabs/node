import { describe, expect, it } from "bun:test"

import { DEFAULT_CONFIG } from "src/config/defaults"
import { freeDiskBytes, lowDiskRefusal } from "./diskSpace"

const GIB = 1024 ** 3

describe("minimum free disk at start", () => {
    it("has a non-zero default, so a node near a full disk does not start", () => {
        expect(DEFAULT_CONFIG.diagnostics.minDiskSpace).toBeGreaterThan(0)
        const min = DEFAULT_CONFIG.diagnostics.minDiskSpace
        expect(lowDiskRefusal(0.5 * GIB, min)).toContain("MIN_DISK_SPACE")
        expect(lowDiskRefusal((min + 1) * GIB, min)).toBeNull()
    })

    it("refuses below the floor and starts at or above it", () => {
        expect(lowDiskRefusal(5 * GIB - 1, 5)).toMatch(/below MIN_DISK_SPACE=5 GiB/)
        expect(lowDiskRefusal(5 * GIB, 5)).toBeNull()
    })

    it("never refuses with the check off or the free space unknown", () => {
        expect(lowDiskRefusal(0, 0)).toBeNull()
        expect(lowDiskRefusal(null, 5)).toBeNull()
    })

    it("reads the free space of a real path and nothing for a missing one", () => {
        expect(freeDiskBytes(process.cwd())).toBeGreaterThan(0)
        expect(freeDiskBytes("/no/such/path/here")).toBeNull()
    })
})
