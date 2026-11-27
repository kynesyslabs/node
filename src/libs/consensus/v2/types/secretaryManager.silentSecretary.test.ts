/**
 * At the release deadline a member replaces a secretary that has not released
 * the phase, reports the same phase to the next member of the ranking and
 * waits for that member's release. The same holds for a secretary whose phase
 * endpoint fails through every retry. A reachable secretary is replaced only
 * while the shard without it still holds a quorum; below that the ping
 * decides whether it is replaced.
 *
 * The member and the next secretary are two managers wired to each other the
 * way manageConsensusRoutines wires them on the network.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import _ from "lodash"
import { mockSecretaryDeps } from "./secretaryManager.testMocks"

const A = "0x" + "aa".repeat(32) // a member
const B = "0x" + "bb".repeat(32) // another member
const S = "0x" + "55".repeat(32) // head of the draw: answers, never releases
const N = "0x" + "66".repeat(32) // next in the ranking
const BLOCK = 101
const NOW = 1_794_665_700
const ROUND = NOW - 2
const PEERLIST = [S, N, A, B]
const GREENLIGHT_TIMEOUT_MS = 150

const sharedState: Record<string, any> = {
    lastBlockNumber: BLOCK - 1,
    lastBlockHash: "hash-100",
    publicKeyHex: A,
    // Quorum 3: one of the four members can be left out, not two.
    shardSize: 4,
    forkConfig: {},
}

mockSecretaryDeps(sharedState)
mock.module("src/libs/utils/calibrateTime", () => ({
    getNetworkTimestamp: () => NOW,
}))
const realPeerlistMerge = await import("../routines/peerlistMerge")
mock.module("../routines/peerlistMerge", () => ({
    ...realPeerlistMerge,
    computeMergedPeerlist: async () => PEERLIST,
    validateMergedPeerlist: async (_ref: number, list: unknown) =>
        Array.isArray(list) ? list : null,
}))

const secretaryModule = await import("./secretaryManager")
const secretaryManager = secretaryModule.default
const { emptyValidationPhase } = await import("./validationStatusTypes")
const waiter = (await import("src/utilities/waiter")).Waiter

type Manager = InstanceType<typeof secretaryManager>
type Answer = { result: number; response: unknown; require_reply: boolean; extra: any }

const phase = (currentPhase: number, waitStatus: boolean) => ({
    ..._.cloneDeep(emptyValidationPhase),
    currentPhase,
    waitStatus,
})

// A report that is taken and not released.
const quiet = (reported: number): Answer => ({
    result: 200,
    response: `Validator phase set to ${reported}`,
    require_reply: false,
    extra: { greenlight: false, timestamp: null, blockRef: BLOCK },
})
// What Peer.longCall returns once every retry got a 500.
const retriesSpent: Answer = {
    result: 400,
    response: "Max retries reached",
    require_reply: false,
    extra: { result: 500, response: "Error waiting for the secretary routine to start" },
}
const taken = (ok: boolean): Answer => ({
    result: ok ? 200 : 400,
    response: "",
    require_reply: false,
    extra: null,
})

let us: string // the validator the attempt under test belongs to
let attempt: Manager // our attempt
let nextRound: Manager | null // N's round once N leads; null while N only answers
let endpointDown: Set<string> // members whose phase endpoint fails every retry
let reports: Record<string, number[]> // phases we reported, by receiver
let pings: Record<string, number>
let greenlights: Array<{ to: string; phase: number; timestamp: number }> // sent by our attempt

function peer(identity: string) {
    return {
        identity,
        connection: { string: `http://${identity.slice(2, 6)}` },
        isLocalNode: identity === us,
        sync: { block: BLOCK - 1, block_hash: "hash-100" },
        connect: async () => {
            pings[identity] = (pings[identity] ?? 0) + 1
            return true
        },
        // getValidatorPhase: every member waits at the phase we wait at.
        call: async (): Promise<Answer> => ({
            result: 200,
            response: [attempt.ourValidatorPhase.currentPhase],
            require_reply: false,
            extra: null,
        }),
        longCall: async (request: any): Promise<Answer> => {
            const { method, params } = request.params[0]
            if (method === "greenlight") {
                const [, timestamp, validatorPhase, peerlist] = params
                // A release sent by our attempt, once we lead.
                if (attempt.checkIfWeAreSecretary()) {
                    greenlights.push({ to: identity, phase: validatorPhase, timestamp })
                }
                // Ours reaches our attempt, the others take theirs.
                if (identity !== us) return taken(true)
                return taken(
                    await attempt.receiveGreenLight(timestamp, validatorPhase, peerlist),
                )
            }
            // setValidatorPhase from us.
            const [reported] = params
            reports[identity] = [...(reports[identity] ?? []), reported]
            if (endpointDown.has(identity)) return retriesSpent
            const round =
                identity === us && attempt.checkIfWeAreSecretary()
                    ? attempt
                    : identity === N
                      ? nextRound
                      : null
            if (!round) return quiet(reported)
            // Answered as manageConsensusRoutines does.
            const data: Record<string, unknown> =
                await round.receiveValidatorPhase(us, reported)
            data.timestamp = round.blockTimestamp
            data.blockRef = round.shard.blockRef
            if (round.mergedPeerlist) data.peerlist = round.mergedPeerlist
            return {
                result: 200,
                response: `Validator phase set to ${reported}`,
                require_reply: false,
                extra: data,
            }
        },
    }
}

/** Our attempt for the block, with S at the head of the draw. */
function startAttempt(secretary = S, as = A): Manager {
    us = as
    sharedState.publicKeyHex = as
    const manager = secretaryManager.getInstance(BLOCK, true)
    manager.shard = {
        CVSA: "seed",
        members: [peer(S), peer(N), peer(A), peer(B)],
        validationPhases: {},
        secretaryKey: secretary,
        blockRef: BLOCK,
    } as any
    manager.ourKey = as
    manager.initializeValidationPhases()
    manager.blockTimestamp = null
    ;(manager as any)._greenlight_timeout = GREENLIGHT_TIMEOUT_MS
    attempt = manager
    return manager
}

/** N's round once it leads: N and B wait at `ourPhase`, A has yet to report it. */
function nextSecretaryLeads(ourPhase: number): Manager {
    const round = new secretaryManager()
    round.shard = {
        CVSA: "seed",
        members: [peer(N), peer(A), peer(B)],
        validationPhases: {
            [N]: phase(ourPhase, true),
            [B]: phase(ourPhase, true),
            [A]: phase(0, false),
        },
        secretaryKey: N,
        blockRef: BLOCK,
    } as any
    round.ourKey = N
    round.checkIfWeAreSecretary = () => true
    round.ourValidatorPhase = phase(ourPhase, true) as any
    round.blockTimestamp = ROUND
    nextRound = round
    return round
}

async function reportPhase(reported: number) {
    await attempt.setOurValidatorPhase(reported, true)
    return await attempt.sendOurValidatorPhaseToSecretary(2)
}

beforeEach(() => {
    (secretaryManager as any).instances.clear()
    waiter.waitList.clear()
    waiter.preHeld.clear()
    nextRound = null
    endpointDown = new Set()
    reports = {}
    pings = {}
    greenlights = []
})

afterEach(() => {
    if (attempt) attempt.runSecretaryRoutine = false
    for (const entry of waiter.waitList.values()) clearTimeout(entry.timeoutId)
    waiter.waitList.clear()
    waiter.preHeld.clear()
    sharedState.publicKeyHex = A
})

describe("a secretary that does not release the phase", () => {
    test("is replaced at the release deadline, and the next member's release is waited for", async () => {
        startAttempt()
        nextSecretaryLeads(1)

        const result = await reportPhase(1)

        expect(result).toBe(ROUND)
        expect(attempt.blockTimestamp).toBe(ROUND)
        expect(attempt.shard.secretaryKey).toBe(N)
        expect([...attempt.passedOverSecretaries]).toEqual([S])
        expect(attempt.shard.members.map(m => m.identity)).toEqual([N, A, B])
        // One report each, and its answer to ping was never asked for.
        expect(reports).toEqual({ [S]: [1], [N]: [1] })
        expect(pings[S]).toBeUndefined()
    })

    test("at the peerlist phase the next member's release brings the merged peerlist", async () => {
        // S released phase 1 and went silent afterwards.
        startAttempt()
        attempt.blockTimestamp = ROUND
        nextSecretaryLeads(3)

        const result = await reportPhase(3)

        expect(result).toBe(ROUND)
        expect(attempt.shard.secretaryKey).toBe(N)
        expect(await attempt.resolveMergedPeerlist()).toEqual(PEERLIST)
    })

    test("is replaced when its phase endpoint fails through every retry", async () => {
        startAttempt()
        endpointDown.add(S)
        nextSecretaryLeads(1)

        const result = await reportPhase(1)

        expect(result).toBe(ROUND)
        expect(attempt.shard.secretaryKey).toBe(N)
        expect([...attempt.passedOverSecretaries]).toEqual([S])
        // The failed report is the evidence: no ping, no second report to S.
        expect(reports).toEqual({ [S]: [1], [N]: [1] })
        expect(pings[S]).toBeUndefined()
    })

    test("is kept once replacing it would leave the shard below the quorum", async () => {
        // N answers like S. After S, three members are left: the quorum itself.
        startAttempt()

        const result = await reportPhase(1)

        expect(result).toBeNull()
        expect([...attempt.passedOverSecretaries]).toEqual([S])
        expect(attempt.shard.secretaryKey).toBe(N)
        expect(attempt.shard.members.map(m => m.identity)).toEqual([N, A, B])
        // The second deadline falls back to the ping, which N answers.
        expect(pings).toEqual({ [N]: 1 })
    })

    test("the secretary never replaces itself on its own deadline", async () => {
        startAttempt(A)

        const result = await reportPhase(1)

        expect(result).toBeNull()
        expect(attempt.shard.secretaryKey).toBe(A)
        expect(attempt.passedOverSecretaries.size).toBe(0)
        expect(attempt.shard.members).toHaveLength(4)
    })

    test("without the caller's evidence a reachable secretary is kept", async () => {
        startAttempt()

        await attempt.handleSecretaryGoneOffline()

        expect(attempt.shard.secretaryKey).toBe(S)
        expect(pings).toEqual({ [S]: 1 })
    })

    test("an attempt that ended is not failed over", async () => {
        startAttempt()
        nextSecretaryLeads(1)
        await attempt.setOurValidatorPhase(1, true)
        const waiting = attempt.sendOurValidatorPhaseToSecretary(2)
        attempt.ended = true

        expect(await waiting).toBeNull()
        expect(attempt.shard.secretaryKey).toBe(S)
        expect(reports[N]).toBeUndefined()
    })
})

describe("the next member of the ranking, at the release deadline", () => {
    test("leads the round: it opens the round's timestamp and releases the members waiting at its phase", async () => {
        // We are N. Nobody was released, so the round has no timestamp yet.
        startAttempt(S, N)

        const result = await reportPhase(1)

        expect(result).toBe(NOW)
        expect(attempt.blockTimestamp).toBe(NOW)
        expect(attempt.shard.secretaryKey).toBe(N)
        expect(attempt.runSecretaryRoutine).toBe(true)
        expect(attempt.shard.members.map(m => m.identity)).toEqual([N, A, B])
        const released = greenlights.filter(g => g.phase === 1)
        expect(new Set(released.map(g => g.to))).toEqual(new Set([N, A, B]))
        expect(released.every(g => g.timestamp === NOW)).toBe(true)
        expect(pings[S]).toBeUndefined()
    })

    test("keeps the timestamp of a round the replaced secretary had opened", async () => {
        // S released phase 1 with ROUND and went silent afterwards.
        startAttempt(S, N)
        attempt.blockTimestamp = ROUND

        const result = await reportPhase(3)

        expect(result).toBe(ROUND)
        expect(attempt.blockTimestamp).toBe(ROUND)
        expect(await attempt.resolveMergedPeerlist()).toEqual(PEERLIST)
        const released = greenlights.filter(g => g.phase === 3)
        expect(new Set(released.map(g => g.to))).toEqual(new Set([N, A, B]))
        expect(released.every(g => g.timestamp === ROUND)).toBe(true)
    })
})
