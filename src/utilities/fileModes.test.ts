import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { CategorizedLogger } from "./tui/CategorizedLogger"
import LegacyLoggerAdapter from "./tui/LegacyLoggerAdapter"
import Wallet from "./cli_libraries/wallet"

const posix = process.platform !== "win32"
const modeOf = (p: string) => fs.statSync(p).mode & 0o777

// A permissive umask is what a container or a service manager may hand the
// node; files holding keys or logs must not depend on it.
describe.skipIf(!posix)("files the node creates are owner-only", () => {
    let dir: string
    let umask: number

    beforeEach(() => {
        umask = process.umask(0)
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "demos-modes-"))
    })

    afterEach(() => {
        CategorizedLogger.resetInstance()
        process.umask(umask)
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it("saves a CLI wallet's private key as 600", async () => {
        const file = path.join(dir, "wallet.key")
        await new Wallet().save(file)
        expect(modeOf(file)).toBe(0o600)
    })

    it("makes an existing world-readable wallet file 600 before writing the key", async () => {
        const file = path.join(dir, "wallet.key")
        fs.writeFileSync(file, "old", { mode: 0o644 })
        fs.chmodSync(file, 0o644)
        const wallet = new Wallet()
        await wallet.save(file)
        expect(modeOf(file)).toBe(0o600)
        expect(fs.readFileSync(file, "utf8")).toBe(wallet.identity.privateKey.toString("hex"))
    })

    it("writes show:pubkey's -o file as 600", () => {
        const out = path.join(dir, "pub")
        const run = Bun.spawnSync(
            [
                "sh",
                "-c",
                `umask 0; exec bun src/libs/utils/showPubkey.ts -o "${out}" "${path.join(dir, "id")}"`,
            ],
            { cwd: path.resolve(import.meta.dir, "../.."), stdout: "ignore", stderr: "ignore" },
        )
        expect(run.exitCode).toBe(0)
        expect(modeOf(out)).toBe(0o600)
    }, 60_000)

    it("creates the logs directory as 700 and log files as 600", async () => {
        const logsDir = path.join(dir, "logs")
        const logger = CategorizedLogger.getInstance({
            logsDir,
            terminalOutput: false,
            minLevel: "debug",
        })
        logger.initLogsDir()
        logger.info("CORE", "a line")
        CategorizedLogger.resetInstance()
        await Bun.sleep(50)

        expect(modeOf(logsDir)).toBe(0o700)
        const files = fs.readdirSync(logsDir)
        expect(files.length).toBeGreaterThan(0)
        for (const f of files) expect(modeOf(path.join(logsDir, f))).toBe(0o600)
    })

    it("makes an existing logs directory 700", () => {
        const logsDir = path.join(dir, "logs")
        fs.mkdirSync(logsDir, { mode: 0o755 })
        fs.chmodSync(logsDir, 0o755)
        CategorizedLogger.getInstance({ logsDir, terminalOutput: false }).initLogsDir()
        expect(modeOf(logsDir)).toBe(0o700)
    })

    it("leaves the working directory's mode alone when logs go there", () => {
        const before = modeOf(process.cwd())
        CategorizedLogger.getInstance({ logsDir: ".", terminalOutput: false }).initLogsDir()
        expect(modeOf(process.cwd())).toBe(before)
    })

    it("leaves the working directory's mode alone when a logs symlink points there", () => {
        const work = path.join(dir, "work")
        fs.mkdirSync(work)
        fs.chmodSync(work, 0o755)
        const logsLink = path.join(dir, "logs-link")
        fs.symlinkSync(work, logsLink)
        const cwd = process.cwd()
        process.chdir(work)
        try {
            CategorizedLogger.getInstance({ logsDir: logsLink, terminalOutput: false }).initLogsDir()
        } finally {
            process.chdir(cwd)
        }
        expect(modeOf(work)).toBe(0o755)
    })

    it("makes the target of a logs symlink 700", () => {
        const target = path.join(dir, "node-logs")
        fs.mkdirSync(target)
        fs.chmodSync(target, 0o755)
        const logsLink = path.join(dir, "logs-link")
        fs.symlinkSync(target, logsLink)
        CategorizedLogger.getInstance({ logsDir: logsLink, terminalOutput: false }).initLogsDir()
        expect(modeOf(target)).toBe(0o700)
    })

    it("creates custom log files as 600", async () => {
        const prefix = LegacyLoggerAdapter.LOG_CUSTOM_PREFIX
        const onlyFlag = LegacyLoggerAdapter.LOG_ONLY_ENABLED
        LegacyLoggerAdapter.LOG_CUSTOM_PREFIX = path.join(dir, "custom_")
        LegacyLoggerAdapter.LOG_ONLY_ENABLED = false
        try {
            await LegacyLoggerAdapter.custom("probe", "line", false)
            expect(modeOf(path.join(dir, "custom_probe.log"))).toBe(0o600)
            await LegacyLoggerAdapter.custom("clean", "line", false, true)
            expect(modeOf(path.join(dir, "custom_clean.log"))).toBe(0o600)
        } finally {
            LegacyLoggerAdapter.LOG_CUSTOM_PREFIX = prefix
            LegacyLoggerAdapter.LOG_ONLY_ENABLED = onlyFlag
        }
    })
})
