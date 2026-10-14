import { describe, it, expect } from "bun:test"
import {
    diffSchedules,
    localScheduleView,
    peerScheduleView,
} from "src/libs/peer/routines/forkScheduleAgreement"

const status = (h: number | null) => ({ activationHeight: h, activated: false, currentHeight: 1 })

describe("fork schedule agreement", () => {
    const ours = localScheduleView(
        {
            osDenomination: { activationHeight: 0 },
            signatureDomain: { activationHeight: 40 },
            web2ProofBinding: { activationHeight: 40 },
        },
        31337,
    )

    it("reports nothing when both sides agree", () => {
        const theirs = peerScheduleView({
            forks: { osDenomination: status(0), signatureDomain: status(40), web2ProofBinding: status(40) },
            chainId: 31337,
        })
        expect(diffSchedules(ours, theirs!)).toEqual([])
    })

    it("names every fork whose height differs", () => {
        const theirs = peerScheduleView({
            forks: { osDenomination: status(0), signatureDomain: status(null), web2ProofBinding: status(50) },
            chainId: 31337,
        })
        expect(diffSchedules(ours, theirs!)).toEqual([
            "signatureDomain: ours 40, theirs null",
            "web2ProofBinding: ours 40, theirs 50",
        ])
    })

    it("names a chain id that differs", () => {
        const theirs = peerScheduleView({ forks: { signatureDomain: status(40) }, chainId: 1 })
        expect(diffSchedules(ours, theirs!)).toEqual(["chainId: ours 31337, theirs 1"])
    })

    it("compares only what the peer reports: an older peer says nothing about a fork or the chain id", () => {
        const theirs = peerScheduleView({ forks: { osDenomination: status(0) } })
        expect(diffSchedules(ours, theirs!)).toEqual([])
    })

    it("has no view of an answer without a fork table", () => {
        expect(peerScheduleView(null)).toBeNull()
        expect(peerScheduleView("nope")).toBeNull()
        expect(peerScheduleView({})).toBeNull()
    })
})
