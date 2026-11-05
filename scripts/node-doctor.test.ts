import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const DOCTOR = path.join(import.meta.dir, "node-doctor")
const BASH = Bun.which("bash") as string
const GREP = Bun.which("grep") as string

let bin: string

/** Puts a fake command on the PATH the check sees, printing `output`. */
function fakeCommand(name: string, output: string): void {
    const file = path.join(bin, name)
    fs.writeFileSync(file, `#!${BASH}\nprintf '%s\\n' ${JSON.stringify(output)}\n`)
    fs.chmodSync(file, 0o755)
}

/** Runs one production check with only the fake commands (and grep) on PATH. */
function runCheck(check: string): { line: string; fails: number; warns: number } {
    const run = Bun.spawnSync(
        [BASH, "-c", `source "${DOCTOR}"; ${check}; echo "fails=$PROD_FAILS warns=$PROD_WARNS"`],
        { env: { PATH: bin } },
    )
    const lines = run.stdout.toString().trim().split("\n")
    const counts = /fails=(\d+) warns=(\d+)/.exec(lines.at(-1) ?? "")
    return {
        line: lines[0],
        fails: Number(counts?.[1]),
        warns: Number(counts?.[2]),
    }
}

beforeEach(() => {
    bin = fs.mkdtempSync(path.join(os.tmpdir(), "node-doctor-"))
    fs.symlinkSync(GREP, path.join(bin, "grep"))
})

afterEach(() => {
    fs.rmSync(bin, { recursive: true, force: true })
})

describe("node-doctor --production clock sync", () => {
    it("passes when timedatectl reports NTPSynchronized=yes", () => {
        fakeCommand("timedatectl", "yes")
        expect(runCheck("check_clock_sync")).toEqual({
            line: "PASS clock sync: timedatectl NTPSynchronized=yes",
            fails: 0,
            warns: 0,
        })
    })

    it("fails when timedatectl reports the clock is not synchronised", () => {
        fakeCommand("timedatectl", "no")
        const result = runCheck("check_clock_sync")
        expect(result.line).toStartWith("FAIL clock sync:")
        expect(result.line).toContain("NTPSynchronized=no")
        expect(result.fails).toBe(1)
    })

    it("passes on chrony when timedatectl says no", () => {
        fakeCommand("timedatectl", "no")
        fakeCommand("chronyc", "Leap status     : Normal")
        expect(runCheck("check_clock_sync").line).toBe(
            "PASS clock sync: chronyc tracking: Leap status Normal",
        )
    })

    it("fails when chrony is installed but not synchronised", () => {
        fakeCommand("chronyc", "Leap status     : Not synchronised")
        expect(runCheck("check_clock_sync").fails).toBe(1)
    })

    it("skips with a warning when neither timedatectl nor chronyc exists", () => {
        const result = runCheck("check_clock_sync")
        expect(result.line).toStartWith("WARN clock sync: skipped")
        expect(result).toMatchObject({ fails: 0, warns: 1 })
    })
})

describe("node-doctor sourcing", () => {
    it("defines the checks without running the doctor", () => {
        const run = Bun.spawnSync([BASH, "-c", `source "${DOCTOR}"; type -t check_clock_sync`], {
            env: { PATH: bin },
        })
        expect(run.stdout.toString().trim()).toBe("function")
    })
})
