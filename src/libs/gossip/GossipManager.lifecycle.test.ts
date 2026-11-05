import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// Lifecycle of the real GossipManager against a fake sidecar process
// (__fixtures__/fakeSidecar.mjs); only the node-side collaborators are
// stubbed.

const gossipCfg = {
    enabled: true,
    port: 9095,
    heightsIntervalMs: 100,
    keyFile: ".unused_gossip_key",
    ipcConnectTimeoutMs: 300,
}

const logLines: string[] = []
const logFn = (level: string) => (msg: unknown) => {
    logLines.push(`${level} ${String(msg)}`)
}
const logger = {
    default: {
        info: logFn("info"),
        warning: logFn("warning"),
        warn: logFn("warning"),
        error: logFn("error"),
        debug: () => undefined,
        custom: () => undefined,
        only: () => undefined,
    },
}
mock.module("src/utilities/logger", () => logger)
mock.module("@/utilities/logger", () => logger)

const sharedState = {
    subsystems: {} as Record<string, { status: string; extra?: unknown }>,
    publicKeyHex: "00",
    lastBlockNumber: 0,
    exposedUrl: "",
    identity: null,
}
mock.module("@/utilities/sharedState", () => ({ getSharedState: sharedState }))
mock.module("src/utilities/sharedState", () => ({ getSharedState: sharedState }))

mock.module("src/config", () => ({
    Config: { getInstance: () => ({ gossip: gossipCfg }) },
    isLoopbackHost: () => false,
    parseNodeUrl: () => null,
}))
mock.module("src/libs/peer", () => ({
    Peer: class {},
    PeerManager: {
        getInstance: () => ({ getAll: () => [], getPeers: () => [] }),
        sayHelloToPeer: async () => "unreachable",
    },
}))
mock.module("src/libs/peer/identityLiveness", () => ({ reportTwin: () => undefined }))
// A slow stake lookup widens the window between "ready" and the end of a launch.
let stakeLookupMs = 0
mock.module("src/libs/consensus/stakedSet", () => ({
    isSelfStaked: async () => {
        if (stakeLookupMs > 0) await Bun.sleep(stakeLookupMs)
        return false
    },
    onSelfStakeChange: () => () => undefined,
    getStakedSet: async () => new Set<string>(),
}))
mock.module("src/libs/network/txSubmission", () => ({
    retryUnpublishedTxs: async () => undefined,
}))
mock.module("./records", () => ({
    buildHeightsRecord: async () => ({}),
    isHeightsRecordShape: () => false,
}))
mock.module("./validators", () => ({
    validateBlockMessage: async () => ({ result: "ignore" }),
    validateHeightsMessage: async () => ({ result: "ignore" }),
    validateTxMessage: async () => ({ result: "ignore" }),
}))
const degradedGauge: boolean[] = []
let relaunchFailures = 0
mock.module("./metrics", () => ({
    registerGossipMetrics: () => undefined,
    countHeightsRecord: () => undefined,
    countPublishSkipped: () => undefined,
    setMeshPeersGauge: () => undefined,
    setReadyGauge: () => undefined,
    countTxIngest: () => undefined,
    countSidecarRestart: () => undefined,
    countSidecarRelaunchFailure: () => {
        relaunchFailures++
    },
    setSidecarDegradedGauge: (d: boolean) => {
        degradedGauge.push(d)
    },
    countInbound: () => undefined,
    countSilenceProbe: () => undefined,
}))

const gossipModule = await import("./GossipManager")

class ExitCalled extends Error {
    constructor(readonly code: number | undefined) {
        super(`process.exit(${code})`)
    }
}

const FIXTURE = path.join(import.meta.dir, "__fixtures__", "fakeSidecar.mjs")
let dir: string
let modeFile: string
let spawnLog: string
let exitCalls: (number | undefined)[]
let exitSpy: ReturnType<typeof spyOn>
const managers: InstanceType<typeof gossipModule.GossipManager>[] = []

function setMode(mode: "ok" | "hang" | "crash" | "readyexit"): void {
    fs.writeFileSync(modeFile, mode)
}

function spawns(): { pid: number; mode: string; at: number }[] {
    if (!fs.existsSync(spawnLog)) return []
    return fs
        .readFileSync(spawnLog, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(l => {
            const [pid, mode, at] = l.split(" ")
            return { pid: Number(pid), mode, at: Number(at) }
        })
}

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch {
        return false
    }
}

async function waitFor(
    cond: () => boolean,
    timeoutMs: number,
    what: string,
): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!cond()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
        await Bun.sleep(20)
    }
}

function manager(
    backoff: { baseMs?: number; capMs?: number; random?: () => number } = {},
) {
    const gm = new gossipModule.GossipManager({ baseMs: 50, capMs: 200, random: () => 1, ...backoff })
    managers.push(gm)
    return gm
}

function lastSpawn() {
    const all = spawns()
    return all[all.length - 1]
}

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gossip-lifecycle-"))
    modeFile = path.join(dir, "mode")
    spawnLog = path.join(dir, "spawns.log")
    process.env.GOSSIP_SIDECAR_PATH = FIXTURE
    process.env.GOSSIP_IPC_PATH = path.join(dir, "gossip.sock")
    process.env.FAKE_SIDECAR_MODE_FILE = modeFile
    process.env.FAKE_SIDECAR_LOG = spawnLog
    setMode("ok")
    sharedState.subsystems = {}
    logLines.length = 0
    degradedGauge.length = 0
    relaunchFailures = 0
    stakeLookupMs = 0
    exitCalls = []
    exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
        exitCalls.push(code)
        throw new ExitCalled(code)
    }) as never)
})

afterEach(async () => {
    for (const gm of managers.splice(0)) await gm.stop()
    for (const s of spawns()) {
        if (alive(s.pid)) process.kill(s.pid, "SIGKILL")
    }
    exitSpy.mockRestore()
    fs.rmSync(dir, { recursive: true, force: true })
})

describe("GossipManager sidecar lifecycle", () => {
    it("keeps the node up when a relaunch times out on IPC, and recovers once the sidecar comes back", async () => {
        const gm = manager()
        await gm.start()
        expect(gm.getPeerId()).toStartWith("fake-")
        expect(sharedState.subsystems.gossip?.status).toBe("ready")
        const first = lastSpawn()

        setMode("hang")
        process.kill(first.pid, "SIGKILL")

        await waitFor(() => relaunchFailures >= 2, 5_000, "two failed relaunches")
        expect(exitCalls).toEqual([])
        expect(gm.getDegradedState()).not.toBeNull()
        expect(gm.getDegradedState()?.reason).toContain("could not connect to sidecar IPC")
        expect(sharedState.subsystems.gossip?.status).toBe("failed")
        expect(gm.isReady()).toBe(false)
        expect(degradedGauge).toContain(true)
        expect(
            logLines.some(l =>
                l.includes("node keeps running without gossip, retrying in"),
            ),
        ).toBe(true)

        const hung = spawns().filter(s => s.mode === "hang")
        setMode("ok")
        await waitFor(() => gm.getDegradedState() === null, 5_000, "recovery")

        expect(exitCalls).toEqual([])
        expect(sharedState.subsystems.gossip?.status).toBe("ready")
        expect(gm.getPeerId()).toBe(`fake-${lastSpawn().pid}`)
        expect(degradedGauge[degradedGauge.length - 1]).toBe(false)
        await waitFor(() => gm.isReady(), 2_000, "ready after recovery")
        // Every half-started sidecar was cleaned up before the next try.
        for (const s of hung) expect(alive(s.pid)).toBe(false)
    })

    it("backs off between repeated failures and caps the delay", async () => {
        const gm = manager({ baseMs: 40, capMs: 160 })
        await gm.start()
        setMode("crash")
        process.kill(lastSpawn().pid, "SIGKILL")

        await waitFor(() => relaunchFailures >= 7, 8_000, "seven failed relaunches")
        expect(exitCalls).toEqual([])
        const crashes = spawns().filter(s => s.mode === "crash")
        const gaps = crashes.slice(1).map((s, i) => s.at - crashes[i].at)
        // random() = 1 makes the delays exact: 40, 80, 160, then capped at 160.
        const floors = [40, 80, 160, 160, 160, 160]
        gaps.slice(0, floors.length).forEach((gap, i) => {
            expect(gap).toBeGreaterThanOrEqual(floors[i] - 5)
        })
        // Capped, not still doubling.
        const tail = gaps.slice(3, 6)
        for (const gap of tail) expect(gap).toBeLessThan(160 + 1_000)

        const before = spawns().length
        await Bun.sleep(400)
        // No spinning: at most ~400/160 more launches in 400 ms.
        expect(spawns().length - before).toBeLessThanOrEqual(3)
    })

    it("stops cleanly while a retry is pending", async () => {
        const gm = manager({ baseMs: 10_000, capMs: 10_000 })
        await gm.start()
        setMode("crash")
        process.kill(lastSpawn().pid, "SIGKILL")
        await waitFor(() => relaunchFailures >= 1, 5_000, "first failed relaunch")
        await waitFor(
            () => (gm.getDegradedState()?.nextAttemptAt ?? 0) > Date.now(),
            2_000,
            "a scheduled retry",
        )

        const launchesBefore = spawns().length
        const t0 = Date.now()
        await gm.stop()
        expect(Date.now() - t0).toBeLessThan(2_000)
        await Bun.sleep(200)
        expect(spawns().length).toBe(launchesBefore)
        expect(exitCalls).toEqual([])
        for (const s of spawns()) expect(alive(s.pid)).toBe(false)
    })

    it("stops cleanly while a relaunch is waiting on IPC", async () => {
        const gm = manager({ baseMs: 50, capMs: 50 })
        gossipCfg.ipcConnectTimeoutMs = 10_000
        try {
            await gm.start()
            setMode("hang")
            process.kill(lastSpawn().pid, "SIGKILL")
            await waitFor(() => lastSpawn().mode === "hang", 5_000, "a hanging relaunch")

            const t0 = Date.now()
            await gm.stop()
            expect(Date.now() - t0).toBeLessThan(3_000)
            expect(exitCalls).toEqual([])
            for (const s of spawns()) expect(alive(s.pid)).toBe(false)
        } finally {
            gossipCfg.ipcConnectTimeoutMs = 300
        }
    })

    it("relaunches a sidecar that exits right after reporting ready", async () => {
        const gm = manager()
        await gm.start()
        stakeLookupMs = 300
        setMode("readyexit")
        process.kill(lastSpawn().pid, "SIGKILL")
        await waitFor(
            () => spawns().filter(s => s.mode === "readyexit").length >= 2,
            5_000,
            "a second relaunch after a ready-then-exit sidecar",
        )
        expect(exitCalls).toEqual([])

        setMode("ok")
        await waitFor(
            () => lastSpawn().mode === "ok" && gm.getDegradedState() === null,
            5_000,
            "recovery onto a healthy sidecar",
        )
        await waitFor(() => gm.isReady(), 2_000, "ready")
        expect(alive(lastSpawn().pid)).toBe(true)
        expect(gm.getPeerId()).toBe(`fake-${lastSpawn().pid}`)
        expect(sharedState.subsystems.gossip?.status).toBe("ready")
    })

    it("does not stay down when the first launch's sidecar exits right after ready", async () => {
        setMode("readyexit")
        stakeLookupMs = 300
        const gm = manager()
        await gm.start()
        expect(exitCalls).toEqual([])
        setMode("ok")
        await waitFor(
            () => lastSpawn().mode === "ok" && gm.isReady(),
            5_000,
            "a healthy sidecar after a ready-then-exit first launch",
        )
        expect(alive(lastSpawn().pid)).toBe(true)
    })

    it("fails fast at first boot when the sidecar entry is missing", async () => {
        process.env.GOSSIP_SIDECAR_PATH = path.join(dir, "missing-sidecar.mjs")
        const gm = manager()
        await expect(gm.start()).rejects.toBeInstanceOf(ExitCalled)
        expect(exitCalls).toEqual([1])
        expect(spawns()).toEqual([])
        expect(logLines.some(l => l.includes("sidecar entry not found"))).toBe(true)
    })

    it("does not exit when the first launch fails transiently; it retries in the background", async () => {
        setMode("hang")
        const gm = manager()
        await gm.start()
        expect(exitCalls).toEqual([])
        expect(gm.getDegradedState()).not.toBeNull()

        setMode("ok")
        await waitFor(() => gm.getDegradedState() === null, 5_000, "recovery")
        expect(sharedState.subsystems.gossip?.status).toBe("ready")
        expect(exitCalls).toEqual([])
    })
})
