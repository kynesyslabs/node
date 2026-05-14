import { describe, expect, it, mock } from "bun:test"

mock.module("@/utilities/logger", () => ({
    default: {
        info: () => undefined,
        warning: () => undefined,
        error: () => undefined,
        debug: () => undefined,
        critical: () => undefined,
    },
}))

const mod = await import("./subsystemRegistry")

describe("SubsystemRegistry", () => {
    it("seeds every known subsystem in pending", () => {
        const reg = mod.buildInitialSubsystemRegistry()
        for (const name of mod.KNOWN_SUBSYSTEMS) {
            expect(reg[name].status).toBe("pending")
            expect(reg[name].since).toBeNull()
        }
    })

    it("markSubsystem transitions state and stamps since on real change", () => {
        const reg = mod.buildInitialSubsystemRegistry()
        mod.markSubsystem(reg, "chain", "running")
        const t1 = reg.chain.since
        expect(reg.chain.status).toBe("running")
        expect(t1).toBeGreaterThan(0)
        // Same status -> since preserved
        mod.markSubsystem(reg, "chain", "running")
        expect(reg.chain.since).toBe(t1)
        // New status -> since updates
        mod.markSubsystem(reg, "chain", "ready")
        expect(reg.chain.status).toBe("ready")
        expect(reg.chain.since!).toBeGreaterThanOrEqual(t1!)
    })

    it("ready transitions clear lastError", () => {
        const reg = mod.buildInitialSubsystemRegistry()
        mod.subsystemError(reg, "chain", new Error("boom"))
        expect(reg.chain.lastError?.message).toBe("boom")
        mod.markSubsystem(reg, "chain", "ready")
        expect(reg.chain.lastError).toBeNull()
    })

    it("skipped records reason in extra", () => {
        const reg = mod.buildInitialSubsystemRegistry()
        mod.markSubsystem(reg, "signaling", "skipped", { reason: "no peers" })
        expect(reg.signaling.status).toBe("skipped")
        expect((reg.signaling.extra as Record<string, unknown>).reason).toBe(
            "no peers",
        )
    })

    it("snapshotSubsystems deep-clones", () => {
        const reg = mod.buildInitialSubsystemRegistry()
        mod.markSubsystem(reg, "rpc", "ready", { port: 53550 })
        const snap = mod.snapshotSubsystems(reg)
        mod.markSubsystem(reg, "rpc", "failed")
        expect(snap.rpc.status).toBe("ready")
        expect(snap.rpc.port).toBe(53550)
    })

    it("port + requestedPort recorded for drift cases", () => {
        const reg = mod.buildInitialSubsystemRegistry()
        mod.markSubsystem(reg, "signaling", "ready", {
            requestedPort: 3005,
            port: 3007,
        })
        expect(reg.signaling.port).toBe(3007)
        expect(reg.signaling.requestedPort).toBe(3005)
    })
})

describe("BootTracker", () => {
    it("register is idempotent", () => {
        const t = new mod.BootTracker()
        t.register("a")
        t.register("a")
        expect(t.snapshot().length).toBe(1)
    })

    it("start -> ready writes timestamps", () => {
        const t = new mod.BootTracker()
        t.start("a")
        const startedAt = t.snapshot()[0].startedAt!
        expect(startedAt).toBeGreaterThan(0)
        t.ready("a")
        const finishedAt = t.snapshot()[0].finishedAt!
        expect(finishedAt).toBeGreaterThanOrEqual(startedAt)
        expect(t.snapshot()[0].status).toBe("ready")
    })

    it("fail records error message", () => {
        const t = new mod.BootTracker()
        t.start("a")
        t.fail("a", new Error("bad"))
        const s = t.snapshot()[0]
        expect(s.status).toBe("failed")
        expect(s.error?.message).toBe("bad")
    })

    it("skip records reason", () => {
        const t = new mod.BootTracker()
        t.skip("a", "no peers")
        const s = t.snapshot()[0]
        expect(s.status).toBe("skipped")
        expect(s.skippedReason).toBe("no peers")
    })

    it("summary counts states + complete flag", () => {
        const t = new mod.BootTracker()
        t.start("a")
        t.ready("a")
        t.start("b")
        t.ready("b")
        t.start("c")
        // c left running
        expect(t.summary()).toMatchObject({
            total: 3,
            ready: 2,
            running: 1,
            complete: false,
            current: "c",
        })
        t.ready("c")
        expect(t.summary().complete).toBe(true)
    })

    it("snapshot is independent of subsequent mutations", () => {
        const t = new mod.BootTracker()
        t.start("a")
        t.ready("a")
        const snap = t.snapshot()
        t.fail("a", new Error("x"))
        expect(snap[0].status).toBe("ready")
    })
})
