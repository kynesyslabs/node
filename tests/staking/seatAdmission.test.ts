import { beforeEach, describe, expect, it } from "bun:test"
import {
    MAX_PENDING_SEAT_TXS_PER_SENDER,
    REFUSED_VERDICT_TTL_MS,
    SEAT_ADMISSION_CACHE_CAP,
    SEAT_TX_RATE_LIMIT,
    SEAT_TX_RATE_WINDOW_MS,
    challengeVerdictKey,
    refusedVerdict,
    rememberRefused,
    resetSeatAdmissionForTesting,
    seatPoolRefusal,
    seatRateRefusal,
    stakeVerdictKey,
} from "@/features/staking/seatAdmission"

const T0 = 1_800_000_000_000

beforeEach(() => resetSeatAdmissionForTesting())

describe("seat transaction rate", () => {
    it("admits the limit per window, then refuses until the oldest attempt ages out", () => {
        for (let i = 0; i < SEAT_TX_RATE_LIMIT; i++) expect(seatRateRefusal("0xAB", T0 + i)).toBeNull()
        expect(seatRateRefusal("0xab", T0 + 10)).toBe("Too many seat transactions from 0xab: at most 3 every 60s")
        expect(seatRateRefusal("0xab", T0 + SEAT_TX_RATE_WINDOW_MS - 1)).not.toBeNull()
        expect(seatRateRefusal("0xab", T0 + SEAT_TX_RATE_WINDOW_MS)).toBeNull()
    })

    it("does not count refused attempts, so retrying does not extend the wait", () => {
        for (let i = 0; i < SEAT_TX_RATE_LIMIT; i++) seatRateRefusal("0xab", T0)
        for (let i = 0; i < 50; i++) expect(seatRateRefusal("0xab", T0 + 1000 + i)).not.toBeNull()
        for (let i = 0; i < SEAT_TX_RATE_LIMIT; i++) expect(seatRateRefusal("0xab", T0 + SEAT_TX_RATE_WINDOW_MS + i)).toBeNull()
    })

    it("counts each sender on its own", () => {
        for (let i = 0; i < SEAT_TX_RATE_LIMIT; i++) seatRateRefusal("0xab", T0)
        expect(seatRateRefusal("0xcd", T0)).toBeNull()
    })

    it("stays bounded under many fresh senders and still limits a busy one", () => {
        for (let i = 0; i < SEAT_TX_RATE_LIMIT; i++) seatRateRefusal("0xbusy", T0)
        for (let i = 0; i < SEAT_ADMISSION_CACHE_CAP + 5; i++) seatRateRefusal(`0x${i}`, T0 + SEAT_TX_RATE_WINDOW_MS)
        expect(seatRateRefusal("0xnew", T0 + SEAT_TX_RATE_WINDOW_MS)).toBeNull()
    })

    it("evicts the least recently seen senders past the cap, not every sender at once", () => {
        for (let i = 0; i < SEAT_TX_RATE_LIMIT; i++) seatRateRefusal("0xbusy", T0)
        // Fresh senders flood the map while the busy one keeps retrying.
        for (let i = 0; i < 2 * SEAT_ADMISSION_CACHE_CAP; i++) {
            seatRateRefusal(`0xflood${i}`, T0 + 1)
            if (i % 1000 === 0) expect(seatRateRefusal("0xbusy", T0 + 1)).not.toBeNull()
        }
        expect(seatRateRefusal("0xbusy", T0 + 2)).not.toBeNull()
        // The oldest flood senders were evicted, the newest are still counted.
        expect(seatRateRefusal(`0xflood${2 * SEAT_ADMISSION_CACHE_CAP - 1}`, T0 + 2)).toBeNull()
        expect(seatRateRefusal(`0xflood${2 * SEAT_ADMISSION_CACHE_CAP - 1}`, T0 + 2)).toBeNull()
        expect(seatRateRefusal(`0xflood${2 * SEAT_ADMISSION_CACHE_CAP - 1}`, T0 + 2)).not.toBeNull()
    })
})

describe("seat transactions held in the pool", () => {
    it("refuses once a sender holds the cap of stakes and challenges", () => {
        expect(seatPoolRefusal([])).toBeNull()
        expect(seatPoolRefusal(["validatorStake", "native", "native"])).toBeNull()
        expect(seatPoolRefusal(["validatorStake", "validatorChallenge"])).toBe(
            `Sender already holds 2 seat transactions in the pool (at most ${MAX_PENDING_SEAT_TXS_PER_SENDER})`,
        )
    })

    it("counts only the transactions that read Solana", () => {
        expect(seatPoolRefusal(["validatorUnstake", "validatorExit", "validatorStake"])).toBeNull()
    })
})

describe("refused verdicts", () => {
    it("hold a refusal for the TTL, then forget it", () => {
        const key = stakeVerdictKey("sig", "0xAB")
        expect(refusedVerdict(key, T0)).toBeNull()
        rememberRefused(key, "memo names another", T0)
        expect(refusedVerdict(key, T0 + REFUSED_VERDICT_TTL_MS - 1)).toBe("memo names another")
        expect(refusedVerdict(key, T0 + REFUSED_VERDICT_TTL_MS)).toBeNull()
        expect(refusedVerdict(key, T0)).toBeNull()
    })

    it("key a stake by proof and validator, a challenge by evidence, proof and seat", () => {
        expect(stakeVerdictKey("sig", "0xAB")).toBe(stakeVerdictKey("sig", "0xab"))
        expect(stakeVerdictKey("sig", "0xab")).not.toBe(stakeVerdictKey("sig", "0xcd"))
        rememberRefused(challengeVerdictKey("ev", "proof", "0xab"), "no", T0)
        expect(refusedVerdict(challengeVerdictKey("ev", "proof", "0xAB"), T0)).toBe("no")
        expect(refusedVerdict(challengeVerdictKey("ev", "proof2", "0xab"), T0)).toBeNull()
        expect(refusedVerdict(challengeVerdictKey("ev2", "proof", "0xab"), T0)).toBeNull()
        expect(refusedVerdict(stakeVerdictKey("ev", "0xab"), T0)).toBeNull()
    })

    it("stay bounded when senders fill the cache with fresh keys", () => {
        for (let i = 0; i < SEAT_ADMISSION_CACHE_CAP + 5; i++) rememberRefused(stakeVerdictKey(`s${i}`, "0xab"), "no", T0)
        expect(refusedVerdict(stakeVerdictKey(`s${SEAT_ADMISSION_CACHE_CAP + 4}`, "0xab"), T0)).toBe("no")
        // Only the oldest went to make room.
        expect(refusedVerdict(stakeVerdictKey("s4", "0xab"), T0)).toBeNull()
        expect(refusedVerdict(stakeVerdictKey("s5", "0xab"), T0)).toBe("no")
    })
})
