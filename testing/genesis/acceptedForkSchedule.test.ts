/**
 * Which fork schedule edits a restart may load
 * (src/libs/blockchain/genesis/acceptedForkSchedule.ts).
 */

import { describe, it, expect } from "bun:test"
import {
    acceptSchedule,
    parseOverrideDigest,
    scheduleDigest,
    scheduleFromForkConfig,
    type ForkSchedule,
} from "src/libs/blockchain/genesis/acceptedForkSchedule"
import { forkScheduleDigest } from "src/libs/peer/routines/forkScheduleAgreement"

const LEAD = 50
const TIP = 1_000

function schedule(forks: Record<string, number | null>, chainId: number | null = 7): ForkSchedule {
    const config: Record<string, { activationHeight: number | null }> = {}
    for (const [name, height] of Object.entries(forks)) config[name] = { activationHeight: height }
    return scheduleFromForkConfig(config, chainId)
}

const launched = schedule({ signatureDomain: 0, commitLock: 0, editBinding: null })

describe("scheduleFromForkConfig", () => {
    it("keeps scheduled forks only, without descriptions, and digests like the peer check", () => {
        const config = {
            signatureDomain: { activationHeight: 0, description: "text" },
            atomicWork: { activationHeight: null },
        }
        const s = scheduleFromForkConfig(config, 7)
        expect(s.forks).toEqual({ signatureDomain: { activationHeight: 0 } })
        expect(scheduleDigest(s)).toBe(forkScheduleDigest(config, 7))
    })
})

describe("acceptSchedule", () => {
    it("accepts the same schedule", () => {
        expect(acceptSchedule(launched, launched, TIP, LEAD, null)).toEqual({ status: "unchanged" })
    })

    it("accepts a new fork scheduled beyond the window", () => {
        const next = schedule({ signatureDomain: 0, commitLock: 0, editBinding: TIP + LEAD + 1 })
        const verdict = acceptSchedule(launched, next, TIP, LEAD, null)
        expect(verdict.status).toBe("accepted")
    })

    it("refuses a new fork inside the window or in the past", () => {
        for (const height of [TIP + LEAD, TIP, 5]) {
            const next = schedule({ signatureDomain: 0, commitLock: 0, editBinding: height })
            expect(acceptSchedule(launched, next, TIP, LEAD, null).status).toBe("refused")
        }
    })

    it("refuses moving or removing an active fork", () => {
        expect(
            acceptSchedule(launched, schedule({ signatureDomain: 5_000, commitLock: 0 }), TIP, LEAD, null)
                .status,
        ).toBe("refused")
        expect(
            acceptSchedule(launched, schedule({ signatureDomain: 0 }), TIP, LEAD, null).status,
        ).toBe("refused")
    })

    it("refuses moving a future fork into the window, accepts moving it further out", () => {
        const planned = schedule({ signatureDomain: 0, editBinding: 2_000 })
        expect(
            acceptSchedule(planned, schedule({ signatureDomain: 0, editBinding: TIP + 10 }), TIP, LEAD, null)
                .status,
        ).toBe("refused")
        expect(
            acceptSchedule(planned, schedule({ signatureDomain: 0, editBinding: 3_000 }), TIP, LEAD, null)
                .status,
        ).toBe("accepted")
    })

    it("refuses a planned fork once it is inside the window", () => {
        const planned = schedule({ signatureDomain: 0, editBinding: TIP + 20 })
        expect(
            acceptSchedule(planned, schedule({ signatureDomain: 0, editBinding: 3_000 }), TIP, LEAD, null)
                .status,
        ).toBe("refused")
    })

    it("refuses a payload change of an active fork", () => {
        const a = scheduleFromForkConfig(
            { gasFeeSeparation: { activationHeight: 0, treasuryAddress: `0x${"1".repeat(64)}` } },
            7,
        )
        const b = scheduleFromForkConfig(
            { gasFeeSeparation: { activationHeight: 0, treasuryAddress: `0x${"2".repeat(64)}` } },
            7,
        )
        const verdict = acceptSchedule(a, b, TIP, LEAD, null)
        expect(verdict.status).toBe("refused")
        if (verdict.status === "refused") expect(verdict.problems.join()).toContain("payload changed")
    })

    it("refuses a chain id change once the signature domain is near or active", () => {
        const verdict = acceptSchedule(
            launched,
            schedule({ signatureDomain: 0, commitLock: 0 }, 8),
            TIP,
            LEAD,
            null,
        )
        expect(verdict.status).toBe("refused")
        const planned = schedule({ signatureDomain: TIP + 20 }, null)
        expect(
            acceptSchedule(planned, schedule({ signatureDomain: TIP + 20 }, 8), TIP, LEAD, null).status,
        ).toBe("refused")
    })

    it("accepts adding a chain id together with a signature domain beyond the window", () => {
        const before = schedule({ osDenomination: 0 }, null)
        const after = schedule({ osDenomination: 0, signatureDomain: TIP + LEAD + 10 }, 1337)
        const verdict = acceptSchedule(before, after, TIP, LEAD, null)
        expect(verdict.status).toBe("accepted")
        if (verdict.status === "accepted") expect(verdict.changes.join()).toContain("chain id: null -> 1337")
    })

    it("accepts a refused schedule only under its own override digest", () => {
        const next = schedule({ signatureDomain: 0, commitLock: 0, editBinding: TIP })
        const refused = acceptSchedule(launched, next, TIP, LEAD, null)
        expect(refused.status).toBe("refused")
        if (refused.status !== "refused") return
        expect(acceptSchedule(launched, next, TIP, LEAD, "f".repeat(64)).status).toBe("refused")
        expect(
            acceptSchedule(launched, next, TIP, LEAD, parseOverrideDigest(` 0x${refused.digest.toUpperCase()} `))
                .status,
        ).toBe("accepted")
    })
})
