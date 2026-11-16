/**
 * A validator that restarts in the middle of a round must rejoin the
 * secretary within one round once its restart signing floor lets it sign.
 *
 * The sequence this guards, on a 3-validator chain: A restarts while C, the
 * secretary, runs a round whose timestamp is at or below A's restart floor.
 * A reports its phases late, after C already released B and C from phase 3,
 * so no group release for phase 3 is coming. C then moves on: the round
 * fails without A's vote and C opens a newer round for the same height. A
 * must neither wait out its green light timeout on the abandoned round nor
 * carry state from one attempt into the next.
 *
 * The secretary and the member are two managers wired to each other the way
 * manageConsensusRoutines wires them on the network.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import _ from "lodash"
import { mockSecretaryDeps } from "./secretaryManager.testMocks"

const A = "0x" + "aa".repeat(32) // the restarted validator, us
const B = "0x" + "bb".repeat(32)
const C = "0x" + "cc".repeat(32) // the secretary
const BLOCK = 101
const NOW = 1_794_665_700
// C's round when A comes back, A's restart floor, and C's next round.
const ROUND_1 = NOW - 52
const FLOOR = NOW - 48
const ROUND_2 = NOW - 5
const PEERLIST = [A, B, C]
const GREENLIGHT_TIMEOUT_MS = 400
let mergeDelayMs = 0

const sharedState: Record<string, any> = {
    lastBlockNumber: BLOCK - 1,
    lastBlockHash: "hash-100",
    publicKeyHex: A,
    shardSize: 3,
    forkConfig: {},
}

mockSecretaryDeps(sharedState)
jest.mock("src/libs/utils/calibrateTime", () => ({
    getNetworkTimestamp: () => NOW,
}))
const realPeerlistMerge = await import("../routines/peerlistMerge")
jest.mock("../routines/peerlistMerge", () => ({
    ...realPeerlistMerge,
    // Merging reads the database on a node, so its result lands after the
    // caller moves on; tests that depend on that order set a delay.
    computeMergedPeerlist: async () => {
        if (mergeDelayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, mergeDelayMs))
        }
        return PEERLIST
    },
    validateMergedPeerlist: async (_ref: number, list: unknown) =>
        Array.isArray(list) ? list : null,
}))

const secretaryModule = await import("./secretaryManager")
const secretaryManager = secretaryModule.default
const SUPERSEDED_ROUND = (secretaryModule as any).SUPERSEDED_ROUND
const { emptyValidationPhase } = await import("./validationStatusTypes")
const waiter = (await import("src/utilities/waiter")).Waiter
const signing = await import("src/libs/identity/signingRecord")
const { recordPrevoteRound } = await import("../commitLock/prevoteRecord")

type Manager = InstanceType<typeof secretaryManager>

const phase = (currentPhase: number, waitStatus: boolean) => ({
    ..._.cloneDeep(emptyValidationPhase),
    currentPhase,
    waitStatus,
})

// The member attempt the secretary's greenlights reach, and the secretary
// round the member's reports reach.
let memberAttempt: Manager | null
let secretaryRound: Manager | null
let greenlightsToA: Array<{ phase: number; timestamp: number }>

function peer(identity: string) {
    return {
        identity,
        connection: { string: `http://${identity.slice(2, 6)}` },
        isLocalNode: false,
        connect: async () => true,
        call: async () => ({ result: 200, response: [secretaryRound?.blockTimestamp] }),
        // C -> member greenlight, or A -> C setValidatorPhase.
        longCall: jest.fn(async (request: any) => {
            const { method, params } = request.params[0]
            if (method === "greenlight") {
                const [, timestamp, validatorPhase, peerlist] = params
                if (identity !== A) {
                    return { result: 200, response: "ok", require_reply: false, extra: null }
                }
                greenlightsToA.push({ phase: validatorPhase, timestamp })
                const taken = memberAttempt
                    ? await memberAttempt.receiveGreenLight(timestamp, validatorPhase, peerlist)
                    : false
                return { result: taken ? 200 : 400, response: "", require_reply: false, extra: null }
            }
            // setValidatorPhase, answered as manageConsensusRoutines does.
            const round = secretaryRound as Manager
            const [reported] = params
            const data: Record<string, unknown> = await round.receiveValidatorPhase(A, reported)
            data.timestamp = round.blockTimestamp
            data.blockRef = round.shard.blockRef
            if (round.mergedPeerlist) data.peerlist = round.mergedPeerlist
            return { result: 200, response: "", require_reply: false, extra: data }
        }),
    }
}

function shard(phases: Record<string, any>) {
    return {
        CVSA: "seed",
        members: [peer(A), peer(B), peer(C)],
        validationPhases: phases,
        secretaryKey: C,
        blockRef: BLOCK,
    } as any
}

/** C's round, as C sees it. */
function openSecretaryRound(
    timestamp: number,
    ourPhase: number,
    phases: Record<string, any>,
    releasedThrough?: number,
): Manager {
    const round = new secretaryManager()
    round.shard = shard(phases)
    round.ourKey = C
    round.checkIfWeAreSecretary = () => true
    round.ourValidatorPhase = phase(ourPhase, true) as any
    round.blockTimestamp = timestamp
    round.mergedPeerlist = (releasedThrough ?? 0) >= 3 ? PEERLIST : null
    // What the secretary routine records when it releases the group; the
    // tests that drive the release itself leave it alone.
    if (releasedThrough !== undefined) {
        Object.assign(round, { releasedPhase: releasedThrough })
    }
    secretaryRound = round
    return round
}

/** A fresh consensus attempt of A for the block, as consensusRoutine starts one. */
function startMemberAttempt(): Manager {
    const attempt = secretaryManager.getInstance(BLOCK, true)
    attempt.shard = shard({
        [A]: phase(0, false),
        [B]: phase(0, false),
        [C]: phase(0, false),
    })
    attempt.ourKey = A
    attempt.checkIfWeAreSecretary = () => false
    attempt.initializeValidationPhases()
    attempt.blockTimestamp = null
    ;(attempt as any)._greenlight_timeout = GREENLIGHT_TIMEOUT_MS
    memberAttempt = attempt
    return attempt
}

/** updateValidatorPhase: our phase, then the secretary's answer. */
async function reportPhase(attempt: Manager, reported: number) {
    await attempt.setOurValidatorPhase(reported, true)
    const started = Date.now()
    const result = await attempt.sendOurValidatorPhaseToSecretary(2)
    return { result, elapsed: Date.now() - started }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

let dir: string
let identityFile: string

beforeEach(() => {
    (secretaryManager as any).instances.clear()
    waiter.waitList.clear()
    waiter.preHeld.clear()
    memberAttempt = null
    secretaryRound = null
    greenlightsToA = []
    mergeDelayMs = 0
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "rejoin-"))
    identityFile = path.join(dir, "identity")
})

afterEach(() => {
    for (const entry of waiter.waitList.values()) clearTimeout(entry.timeoutId)
    waiter.waitList.clear()
    fs.rmSync(dir, { recursive: true, force: true })
})

describe("a validator that restarts mid-round", () => {
    test("gets phase 3 and the merged peerlist at once when it reports after the secretary released it", async () => {
        // C released B and C from phase 3 and is forging; A's earlier
        // attempt in this round was released too.
        openSecretaryRound(ROUND_1, 3, {
            [A]: phase(3, false),
            [B]: phase(3, false),
            [C]: phase(3, false),
        }, 3)
        const attempt = startMemberAttempt()

        const one = await reportPhase(attempt, 1)
        expect(one.result).toBe(ROUND_1)

        const three = await reportPhase(attempt, 3)
        expect(three.elapsed).toBeLessThan(GREENLIGHT_TIMEOUT_MS)
        expect(three.result).toBe(ROUND_1)
        expect(await attempt.resolveMergedPeerlist()).toEqual(PEERLIST)
    })

    test("is released when it reports a phase below the secretary's", async () => {
        // The same report once C is past phase 3: a member behind the
        // secretary's phase is released on its report.
        const round = openSecretaryRound(ROUND_1, 6, {
            [A]: phase(3, false),
            [B]: phase(6, true),
            [C]: phase(6, true),
        }, 3)
        const attempt = startMemberAttempt()
        await reportPhase(attempt, 1)
        const three = await reportPhase(attempt, 3)
        expect(three.result).toBe(ROUND_1)
        expect(round.shard.validationPhases[A].waitStatus).toBe(false)
    })

    test("after the secretary's group release of phase 3, a late report of phase 3 is let through", async () => {
        const round = openSecretaryRound(ROUND_1, 3, {
            [A]: phase(3, true),
            [B]: phase(3, true),
            [C]: phase(3, true),
        })
        // A's earlier attempt is gone when the release reaches it.
        expect(await round.releaseWaitingRoutine(true)).toBe(true)
        await settle()
        expect(round.shard.validationPhases[B].waitStatus).toBe(false)

        const attempt = startMemberAttempt()
        await reportPhase(attempt, 1)
        const three = await reportPhase(attempt, 3)
        expect(three.elapsed).toBeLessThan(GREENLIGHT_TIMEOUT_MS)
        expect(three.result).toBe(ROUND_1)
        expect(await attempt.resolveMergedPeerlist()).toEqual(PEERLIST)
    })

    test("after the secretary's timeout release of phase 3, a late report of phase 3 is let through", async () => {
        const round = openSecretaryRound(ROUND_1, 3, {
            [A]: phase(1, false),
            [B]: phase(3, true),
            [C]: phase(3, true),
        })
        round.mergedPeerlist = PEERLIST
        await round.releaseAfterTimeout()
        await settle()
        expect(round.shard.validationPhases[B].waitStatus).toBe(false)

        const attempt = startMemberAttempt()
        await reportPhase(attempt, 1)
        const three = await reportPhase(attempt, 3)
        expect(three.elapsed).toBeLessThan(GREENLIGHT_TIMEOUT_MS)
        expect(three.result).toBe(ROUND_1)
    })

    test("a late phase 3 report released before the peerlist was merged still gets the peerlist", async () => {
        // A timeout release with nobody left to greenlight records the phase
        // without merging the peerlist.
        const round = openSecretaryRound(ROUND_1, 3, {
            [A]: phase(1, false),
            [B]: phase(3, false),
            [C]: phase(3, false),
        }, 3)
        round.mergedPeerlist = null
        mergeDelayMs = 50

        const attempt = startMemberAttempt()
        await reportPhase(attempt, 1)
        const three = await reportPhase(attempt, 3)
        expect(three.elapsed).toBeLessThan(GREENLIGHT_TIMEOUT_MS)
        expect(three.result).toBe(ROUND_1)
        expect(round.mergedPeerlist).toEqual(PEERLIST)
        expect(await attempt.resolveMergedPeerlist()).toEqual(PEERLIST)
    })

    test("a secretary still waiting for the group does not release a member early", async () => {
        // Phase 3 not released yet: A must wait for B like everyone else.
        const round = openSecretaryRound(ROUND_1, 3, {
            [A]: phase(1, false),
            [B]: phase(1, false),
            [C]: phase(3, true),
        }, 1)
        const attempt = startMemberAttempt()
        attempt.blockTimestamp = ROUND_1
        await attempt.setOurValidatorPhase(3, true)
        const waiting = attempt.sendOurValidatorPhaseToSecretary(2)
        await settle()
        expect(greenlightsToA.filter(g => g.phase === 3)).toHaveLength(0)
        expect(round.shard.validationPhases[A].waitStatus).toBe(true)

        // B reports phase 3: the group release reaches A.
        await round.receiveValidatorPhase(B, 3)
        expect(await waiting).toBe(ROUND_1)
        expect(await attempt.resolveMergedPeerlist()).toEqual(PEERLIST)
    })

    test("leaves a round the secretary abandoned at the first greenlight of the newer round", async () => {
        // A waits for phase 3 in C's first round, which ends without
        // releasing it. C's next round releases phase 1 on its timeout.
        openSecretaryRound(ROUND_1, 3, {
            [A]: phase(1, false),
            [B]: phase(1, false),
            [C]: phase(3, true),
        }, 1)
        const attempt = startMemberAttempt()
        attempt.blockTimestamp = ROUND_1
        await attempt.setOurValidatorPhase(3, true)
        const started = Date.now()
        const waiting = attempt.sendOurValidatorPhaseToSecretary(2)
        await settle()

        expect(await attempt.receiveGreenLight(ROUND_2, 1)).toBe(true)
        const result = await waiting
        expect(Date.now() - started).toBeLessThan(GREENLIGHT_TIMEOUT_MS)
        expect(result).toBeDefined()
        expect(result).toBe(SUPERSEDED_ROUND)
        // The attempt keeps the round it was in; the next attempt joins the new one.
        expect(attempt.blockTimestamp).toBe(ROUND_1)
    })

    test("leaves the round when the secretary answers a report from a newer round", async () => {
        // A's attempt began in C's first round; its phase 3 report reaches
        // C's next round, which is still gathering phase 1.
        openSecretaryRound(ROUND_2, 1, {
            [A]: phase(0, false),
            [B]: phase(1, true),
            [C]: phase(1, true),
        }, 0)
        const attempt = startMemberAttempt()
        attempt.blockTimestamp = ROUND_1
        const three = await reportPhase(attempt, 3)
        expect(three.elapsed).toBeLessThan(GREENLIGHT_TIMEOUT_MS)
        expect(three.result).toBeDefined()
        expect(three.result).toBe(SUPERSEDED_ROUND)
    })

    test("greenlights and answers of the round we are in never end the attempt", async () => {
        const round = openSecretaryRound(ROUND_1, 3, {
            [A]: phase(1, false),
            [B]: phase(1, false),
            [C]: phase(3, true),
        }, 1)
        const attempt = startMemberAttempt()
        attempt.blockTimestamp = ROUND_1
        await attempt.setOurValidatorPhase(3, true)
        const waiting = attempt.sendOurValidatorPhaseToSecretary(2)
        await settle()

        // A repeated phase 1 greenlight of the same round, as a timeout
        // release sends to a member that is ahead: ignored, as before.
        expect(await attempt.receiveGreenLight(ROUND_1, 1)).toBe(true)
        // An older round: refused, as before.
        expect(await attempt.receiveGreenLight(ROUND_1 - 10, 1)).toBe(false)
        await settle()
        expect(attempt.supersededBy).toBeNull()

        await round.receiveValidatorPhase(B, 3)
        expect(await waiting).toBe(ROUND_1)
        expect(attempt.supersededBy).toBeNull()
    })

    test("an answer from another height or with a timestamp we would not sign does not end the attempt", async () => {
        for (const answer of [
            { blockRef: BLOCK + 1, timestamp: ROUND_2 },
            { blockRef: BLOCK, timestamp: NOW + 60 },
        ]) {
            const attempt = startMemberAttempt()
            attempt.blockTimestamp = ROUND_1
            ;(attempt as any)._greenlight_timeout = 100
            const secretary = attempt.shard.members.find((m: any) => m.identity === C)
            secretary.longCall = async () => ({
                result: 200,
                response: "",
                require_reply: false,
                extra: { greenlight: false, ...answer },
            })
            await attempt.setOurValidatorPhase(3, true)
            const result = await attempt.sendOurValidatorPhaseToSecretary(2)
            expect(result).not.toBe(SUPERSEDED_ROUND)
            expect(attempt.supersededBy).toBeNull()
            await attempt.endConsensusRoutine()
        }
    })

    test("an attempt told of a newer round does not wait on its next phase", async () => {
        const round = openSecretaryRound(ROUND_2, 1, {
            [A]: phase(0, false),
            [B]: phase(1, true),
            [C]: phase(1, true),
        }, 0)
        const attempt = startMemberAttempt()
        attempt.blockTimestamp = ROUND_1
        await attempt.setOurValidatorPhase(3, true)
        // Arrives while A forges, between two waits.
        expect(await attempt.receiveGreenLight(ROUND_2, 1)).toBe(true)

        const six = await reportPhase(attempt, 6)
        expect(six.elapsed).toBeLessThan(GREENLIGHT_TIMEOUT_MS)
        expect(six.result).toBeDefined()
        expect(six.result).toBe(SUPERSEDED_ROUND)
        // A phase of the abandoned round must not count as A's place in the
        // newer one.
        expect(round.shard.validationPhases[A].currentPhase).toBe(0)
    })

    test("a greenlight for an attempt that already ended leaves nothing for the next attempt", async () => {
        const ended = startMemberAttempt()
        ended.blockTimestamp = ROUND_1
        await ended.setOurValidatorPhase(3, true)
        // The attempt ends while the greenlight is being handled.
        ended.ended = true
        await ended.receiveGreenLight(ROUND_1, 3, PEERLIST)
        expect(waiter.preHeld.has(waiter.keys.GREEN_LIGHT + BLOCK + 3)).toBe(false)

        // The next attempt waits for its own greenlight instead of taking a
        // stale one and then finding no peerlist.
        openSecretaryRound(ROUND_2, 3, {
            [A]: phase(0, false),
            [B]: phase(3, false),
            [C]: phase(3, false),
        }, 3)
        const next = startMemberAttempt()
        await reportPhase(next, 1)
        const three = await reportPhase(next, 3)
        expect(three.result).toBe(ROUND_2)
        expect(await next.resolveMergedPeerlist()).toEqual(PEERLIST)
    })

    test("rejoins within one round and still never signs at or below its restart floor", async () => {
        signing.setRestartSigningFloor(FLOOR)
        const prevote = (round: number, hash: string) =>
            recordPrevoteRound(identityFile, {
                genesisHash: "genesis",
                height: BLOCK,
                round,
                hash,
            })

        // C's first round: A is let through to forging at once, and the
        // floor refuses the round, as it must.
        openSecretaryRound(ROUND_1, 3, {
            [A]: phase(3, false),
            [B]: phase(3, false),
            [C]: phase(3, false),
        }, 3)
        const first = startMemberAttempt()
        await reportPhase(first, 1)
        expect((await reportPhase(first, 3)).result).toBe(ROUND_1)
        expect(signing.restartFloorRefusal(ROUND_1)).toContain("restart signing floor")
        expect(() => prevote(ROUND_1, "x")).toThrow("restart signing floor")
        await first.endConsensusRoutine()

        // C's next round: A joins it in step with B and C.
        const round = openSecretaryRound(ROUND_2, 1, {
            [A]: phase(0, false),
            [B]: phase(1, true),
            [C]: phase(1, true),
        }, 0)
        const next = startMemberAttempt()
        expect((await reportPhase(next, 1)).result).toBe(ROUND_2)
        round.ourValidatorPhase = phase(3, true) as any
        await round.receiveValidatorPhase(C, 3)
        const waiting = reportPhase(next, 3)
        await settle()
        await round.receiveValidatorPhase(B, 3)
        const three = await waiting
        expect(three.result).toBe(ROUND_2)
        expect(three.elapsed).toBeLessThan(GREENLIGHT_TIMEOUT_MS)
        expect(await next.resolveMergedPeerlist()).toEqual(PEERLIST)
        expect(next.blockTimestamp).toBe(ROUND_2)

        // The round is past the floor: A prevotes once, and never another
        // block in the same round.
        expect(signing.restartFloorRefusal(ROUND_2)).toBeNull()
        expect(() => prevote(ROUND_2, "y")).not.toThrow()
        expect(() => prevote(ROUND_2, "z")).toThrow("already prevoted")
        expect(() => prevote(ROUND_1, "y")).toThrow()
    })
})
