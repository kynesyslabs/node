import { describe, expect, it } from "bun:test"
import { detectDocker, isForegroundOnTerminal } from "./context"

describe("detectDocker", () => {
    it("reads the flag in any case and lets an explicit off win", () => {
        for (const v of ["true", "TRUE", "1"]) expect(detectDocker({ DEMOS_IN_DOCKER: v })).toBe(true)
        for (const v of ["false", "FALSE", "0"]) expect(detectDocker({ DEMOS_IN_DOCKER: v })).toBe(false)
    })
})

describe("isForegroundOnTerminal", () => {
    // pid (comm) state ppid pgrp session tty_nr tpgid ...
    const stat = (pgrp: number, tpgid: number, comm = "bun") => `4242 (${comm}) S 1 ${pgrp} ${pgrp} 34816 ${tpgid} 4194304 100`

    it("is true in the terminal's foreground group, false in a background one", () => {
        expect(isForegroundOnTerminal(stat(500, 500))).toBe(true)
        expect(isForegroundOnTerminal(stat(500, 321))).toBe(false)
    })

    it("treats no controlling terminal (-1) as nothing to stop on", () => {
        expect(isForegroundOnTerminal(stat(500, -1))).toBe(true)
    })

    it("reads a command name that contains spaces and parentheses", () => {
        expect(isForegroundOnTerminal(stat(500, 321, "my (odd) name"))).toBe(false)
        expect(isForegroundOnTerminal(stat(500, 500, "my (odd) name"))).toBe(true)
    })

    it("fails safe: a missing, unreadable or garbled file means the offer is skipped", () => {
        const missing = () => {
            throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
        }
        expect(isForegroundOnTerminal(missing)).toBe(false)
        for (const garbage of ["garbage", "", "1 (x) S", "1 (x) S 1 two 3 4 five", ") ) )", "\u0000\u0001", "4242 (bun) S 1 500 500 34816 abc 0"]) {
            expect([garbage, isForegroundOnTerminal(garbage)]).toEqual([garbage, false])
        }
    })

    it("reads the real /proc/self/stat on Linux and returns a boolean", () => {
        expect(typeof isForegroundOnTerminal()).toBe("boolean")
    })
})
