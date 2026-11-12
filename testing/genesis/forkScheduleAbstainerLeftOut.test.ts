import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import {
    applyRoundOutcome,
    onSecretaryUnresponsive,
    resetWindowCheck,
    RECHECK_INTERVAL_MS,
    type CheckPlan,
} from "src/libs/peer/routines/forkScheduleWatch"
import {
    compareSchedules,
    localScheduleView,
} from "src/libs/peer/routines/forkScheduleAgreement"
import { getMetricsService } from "src/features/metrics/MetricsService"
import { Config } from "src/config"
import { getSharedState } from "src/utilities/sharedState"
import GCR from "src/libs/blockchain/gcr/gcr"

// The rehearsal case: validator d alone schedules atomicWork at 62, the other
// three schedule nothing ahead, and the chain is at 17. d abstains by its own
// window; the others see no window of theirs at all.
const TIP = 17
const noWindowOfOurs: CheckPlan = { due: true, inWindow: false, nearest: null }
const OURS = { signatureDomain: { activationHeight: 0 }, atomicWork: { activationHeight: null } }
const D_SCHEDULE = { signatureDomain: { activationHeight: 0 }, atomicWork: { activationHeight: 62 } }

let restore: Array<() => void> = []

beforeEach(() => {
    resetWindowCheck()
    getSharedState.forkScheduleAbstain = false
    getSharedState.forkScheduleAbstainReason = ""
    getSharedState.forkScheduleDifferingPeers = new Set()
    const config = spyOn(Config, "getInstance").mockReturnValue({
        core: { forkScheduleMismatchPolicy: "abstain" },
    } as never)
    const gauge = spyOn(getMetricsService(), "setGauge").mockImplementation((() => {}) as never)
    const setTimer = spyOn(globalThis, "setInterval").mockImplementation((() => 1234) as never)
    const clearTimer = spyOn(globalThis, "clearInterval").mockImplementation((() => {}) as never)
    restore = [
        () => config.mockRestore(),
        () => gauge.mockRestore(),
        () => setTimer.mockRestore(),
        () => clearTimer.mockRestore(),
    ]
})

afterEach(async () => {
    getSharedState.forkScheduleDifferingPeers = new Set()
    await applyRoundOutcome(0, noWindowOfOurs, { mismatched: [], agreed: 1 })
    for (const undo of restore) undo()
    getSharedState.forkScheduleAbstain = false
    getSharedState.forkScheduleAbstainReason = ""
})

describe("a validator that schedules a fork the others do not", () => {
    it("is reported with its own nearest scheduled height", () => {
        const ours = localScheduleView(OURS as never, 1)
        const theirs = localScheduleView(D_SCHEDULE as never, 1)
        const result = compareSchedules(ours, theirs, TIP)
        expect(result.status).toBe("mismatch")
        expect(result.status === "mismatch" && result.theirNearest).toBe(62)
        const past = compareSchedules(ours, theirs, 70)
        expect(past.status === "mismatch" && past.theirNearest).toBeUndefined()
    })

    it("is left out of the shard by the majority while inside its own window", async () => {
        await applyRoundOutcome(TIP, noWindowOfOurs, {
            mismatched: ["http://d"],
            agreed: 2,
            mismatchedIdentities: ["0xD"],
            agreedIdentities: ["0xa", "0xb"],
            validatorIdentities: null,
            mismatchedInTheirWindow: ["0xD"],
        })
        expect([...getSharedState.forkScheduleDifferingPeers]).toEqual(["0xd"])
        expect(getSharedState.forkScheduleAbstain).toBe(false)
    })

    it("is not left out while its own nearest height is still far ahead", async () => {
        await applyRoundOutcome(TIP, noWindowOfOurs, {
            mismatched: ["http://d"],
            agreed: 2,
            mismatchedIdentities: ["0xd"],
            agreedIdentities: ["0xa", "0xb"],
            validatorIdentities: null,
            mismatchedInTheirWindow: [],
        })
        expect(getSharedState.forkScheduleDifferingPeers.size).toBe(0)
    })

    it("leaves nobody out when it and another validator outnumber the agreeing answers", async () => {
        await applyRoundOutcome(TIP, noWindowOfOurs, {
            mismatched: ["http://c", "http://d"],
            agreed: 1,
            mismatchedIdentities: ["0xc", "0xd"],
            agreedIdentities: ["0xb"],
            validatorIdentities: null,
            mismatchedInTheirWindow: ["0xc", "0xd"],
        })
        expect(getSharedState.forkScheduleDifferingPeers.size).toBe(0)
    })
})

describe("a round whose secretary never answers", () => {
    async function withValidators(run: (calls: () => number) => Promise<void>) {
        const PeerManager = (await import("src/libs/peer/PeerManager")).default
        const saved = {
            forkConfig: getSharedState.forkConfig,
            chainId: getSharedState.chainId,
            tip: getSharedState.lastBlockNumber,
        }
        getSharedState.forkConfig = OURS as never
        getSharedState.chainId = 1
        getSharedState.lastBlockNumber = TIP
        const ours = localScheduleView(OURS as never, 1)
        const dView = localScheduleView(D_SCHEDULE as never, 1)
        let calls = 0
        const answering = (forks: unknown, digest: string) => async () => {
            calls++
            return { result: 200, response: { chainId: 1, forks, forkScheduleDigest: digest } }
        }
        const peer = (identity: string, forks: unknown, digest: string) => ({
            identity,
            connection: { string: "http://" + identity },
            call: answering(forks, digest),
        })
        const peers = [
            peer("0xa", OURS, ours.digest as string),
            peer("0xb", OURS, ours.digest as string),
            peer("0xd", D_SCHEDULE, dView.digest as string),
        ]
        const manager = spyOn(PeerManager, "getInstance").mockReturnValue({
            getPeers: () => peers,
        } as never)
        const validators = spyOn(GCR, "getGCRValidatorsAtBlockOrThrow").mockResolvedValue([
            { address: "0xa" },
            { address: "0xb" },
            { address: "0xc" },
            { address: "0xd" },
        ] as never)
        try {
            await run(() => calls)
        } finally {
            manager.mockRestore()
            validators.mockRestore()
            getSharedState.forkConfig = saved.forkConfig
            getSharedState.chainId = saved.chainId
            getSharedState.lastBlockNumber = saved.tip
        }
    }

    it("compares the schedules at once and leaves the abstaining validator out", async () => {
        await withValidators(async () => {
            await onSecretaryUnresponsive(1_000_000)
            expect([...getSharedState.forkScheduleDifferingPeers]).toEqual(["0xd"])
            expect(getSharedState.forkScheduleAbstain).toBe(false)
        })
    }, 30000)

    it("compares at most once per recheck interval however often rounds abort", async () => {
        await withValidators(async calls => {
            await onSecretaryUnresponsive(1_000_000)
            const afterFirst = calls()
            expect(afterFirst).toBe(3)
            await onSecretaryUnresponsive(1_000_000 + 1_000)
            await onSecretaryUnresponsive(1_000_000 + RECHECK_INTERVAL_MS - 1)
            expect(calls()).toBe(afterFirst)
            await onSecretaryUnresponsive(1_000_000 + RECHECK_INTERVAL_MS)
            expect(calls()).toBe(afterFirst * 2)
        })
    }, 30000)
})
