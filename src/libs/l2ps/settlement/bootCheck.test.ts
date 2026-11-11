import { afterEach, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import * as path from "node:path"
import { getSharedState } from "@/utilities/sharedState"
import { cloneDefaultForkConfig } from "@/forks/forkConfig"
import { settlementProverProblem, settlementScheduled, settlementVerifierProblem } from "./bootCheck"

const saved = getSharedState.forkConfig
afterEach(() => {
    getSharedState.forkConfig = saved
})

const schedule = (activationHeight: number | null) => {
    const config = cloneDefaultForkConfig()
    config.l2psSettlement.activationHeight = activationHeight
    getSharedState.forkConfig = config
}

const missingKey = () => {
    throw new Error("ENOENT: verification_key.json")
}

describe("settlement boot checks", () => {
    it("count the fork as scheduled at any height, ahead of activation too", () => {
        schedule(null)
        expect(settlementScheduled()).toBe(false)
        schedule(0)
        expect(settlementScheduled()).toBe(true)
        schedule(1_000_000)
        expect(settlementScheduled()).toBe(true)
    })

    it("refuse every node that cannot load the verification key once the fork is scheduled", () => {
        expect(settlementVerifierProblem(false, missingKey)).toBeNull()
        expect(settlementVerifierProblem(true, missingKey)).toContain("cannot verify settlement proofs: ENOENT")
        expect(settlementVerifierProblem(true, () => ({}))).toBeNull()
    })

    it("ask a subnet member, and only a member, for its proving files and a prover that starts", async () => {
        const ok = { scheduled: true, member: true, built: () => true, probe: async () => {} }
        expect(await settlementProverProblem(ok)).toBeNull()
        expect(await settlementProverProblem({ ...ok, built: () => false })).toContain("proving key or circuit is missing")
        const dead = { ...ok, probe: async () => Promise.reject(new Error("settlement prover 0 exited (code 2, signal null)")) }
        expect(await settlementProverProblem(dead)).toContain("prover does not start: settlement prover 0 exited")
        expect(await settlementProverProblem({ ...dead, built: () => false, member: false })).toBeNull()
        expect(await settlementProverProblem({ ...dead, scheduled: false })).toBeNull()
    })
})

describe("boot order", () => {
    // index.ts cannot be imported in a test (it boots the node), so the
    // order is read from its source.
    const source = readFileSync(path.join(import.meta.dir, "..", "..", "..", "index.ts"), "utf8")
    const bodyOf = (name: string) => {
        const start = source.indexOf(`async function ${name}()`)
        expect(start).toBeGreaterThan(-1)
        return source.slice(start, source.indexOf("\n}\n", start))
    }

    it("checks the settlement prover before the node serves or joins consensus", () => {
        const pre = bodyOf("preMainLoop")
        const load = pre.indexOf("await loadL2PSNetworks()")
        expect(load).toBeGreaterThan(-1)
        expect(load).toBeLessThan(pre.indexOf("await startInboundServers()"))
        expect(load).toBeLessThan(pre.indexOf("await peerBootstrap("))
        expect(bodyOf("loadL2PSNetworks")).toContain("settlementProverProblem(")
        expect(source.split("settlementProverProblem(").length - 1).toBe(1)
        expect(source.split("loadAllL2PS(").length - 1).toBe(1)
        expect(source.indexOf("await preMainLoop()")).toBeLessThan(source.indexOf("        mainLoop()\n"))
    })
})
