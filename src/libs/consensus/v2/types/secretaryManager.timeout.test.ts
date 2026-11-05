/**
 * After SET_WAIT_STATUS times out, the secretary pings the members that did
 * not report and releases the ones still waiting at its phase. Members that
 * reported a later phase during the ping keep their wait status, so the next
 * phase does not time out on them.
 */

import { beforeEach, describe, expect, jest, test } from "bun:test"

const OUR_KEY = "0x" + "aa".repeat(32)
const WAITING_A = "0x" + "11".repeat(32)
const WAITING_B = "0x" + "22".repeat(32)
const AHEAD = "0x" + "33".repeat(32)
const SILENT_ONLINE = "0x" + "44".repeat(32)
const SILENT_OFFLINE = "0x" + "55".repeat(32)

const sharedState: Record<string, any> = {
    lastBlockNumber: 100,
    lastBlockHash: "hash-100",
    publicKeyHex: OUR_KEY,
    shardSize: 6,
    forkConfig: {},
}

jest.mock("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
        warning: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        only: jest.fn(),
    },
}))
jest.mock("src/utilities/sharedState", () => ({
    __esModule: true,
    default: sharedState,
    getSharedState: sharedState,
}))
jest.mock("src/libs/peer", () => ({ Peer: class {}, PeerManager: { getInstance: () => ({}) } }))
jest.mock("src/libs/blockchain/chain", () => ({ __esModule: true, default: {} }))
const realPeerlistMerge = await import("../routines/peerlistMerge")
jest.mock("../routines/peerlistMerge", () => ({
    ...realPeerlistMerge,
    computeMergedPeerlist: async () => [],
}))

const { default: SecretaryManager } = await import("./secretaryManager")

type Member = {
    identity: string
    connection: { string: string }
    isLocalNode: boolean
    connect: () => Promise<boolean>
    longCall: ReturnType<typeof jest.fn>
}

const phase = (currentPhase: number, waitStatus: boolean) => ({
    currentPhase,
    waitStatus,
    phases: { 1: ["a", false], 3: ["b", false], 6: ["c", false] },
    blockReferenced: 101,
})

function member(identity: string, connect: () => Promise<boolean>): Member {
    return {
        identity,
        connection: { string: `http://${identity.slice(2, 6)}` },
        isLocalNode: identity === OUR_KEY,
        connect,
        longCall: jest.fn(async () => ({
            result: 200,
            response: "ok",
            require_reply: false,
            extra: null,
        })),
    }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

beforeEach(() => {
    (SecretaryManager as any).instances.clear()
})

describe("SecretaryManager.releaseAfterTimeout", () => {
    test("releases the members waiting at our phase and leaves members already ahead alone", async () => {
        const manager = SecretaryManager.getInstance(101, true)
        const members: Record<string, Member> = {}
        for (const id of [OUR_KEY, WAITING_A, WAITING_B, AHEAD, SILENT_OFFLINE]) {
            members[id] = member(id, async () => false)
        }
        // The ping takes a while; the silent member answers it, and meanwhile
        // another member reports phase 6.
        members[SILENT_ONLINE] = member(SILENT_ONLINE, async () => {
            await sleep(50)
            return true
        })
        manager.shard = {
            CVSA: "seed",
            members: Object.values(members),
            validationPhases: {
                [OUR_KEY]: phase(3, true),
                [WAITING_A]: phase(3, true),
                [WAITING_B]: phase(3, true),
                [AHEAD]: phase(3, true),
                [SILENT_ONLINE]: phase(1, false),
                [SILENT_OFFLINE]: phase(1, false),
            },
            secretaryKey: OUR_KEY,
            blockRef: 101,
        } as any
        manager.ourValidatorPhase = phase(3, true) as any
        manager.blockTimestamp = 1_000
        manager.mergedPeerlist = []

        setTimeout(() => {
            manager.shard.validationPhases[AHEAD] = phase(6, true) as any
        }, 10)

        await manager.releaseAfterTimeout()

        const phases = manager.shard.validationPhases
        expect(phases[AHEAD].currentPhase).toBe(6)
        expect(phases[AHEAD].waitStatus).toBe(true)
        expect(members[AHEAD].longCall).not.toHaveBeenCalled()

        for (const id of [OUR_KEY, WAITING_A, WAITING_B, SILENT_ONLINE]) {
            expect(phases[id].waitStatus).toBe(false)
            expect(members[id].longCall).toHaveBeenCalledTimes(1)
            const request = members[id].longCall.mock.calls[0][0] as any
            expect(request.params[0].params[2]).toBe(3)
        }

        expect(manager.unresponsiveMembers.has(SILENT_OFFLINE)).toBe(true)
        expect(manager.unresponsiveMembers.has(SILENT_ONLINE)).toBe(false)
        expect(members[SILENT_OFFLINE].longCall).not.toHaveBeenCalled()
    })

    test("a member that reports the next phase while the peerlist is being merged is left alone", async () => {
        const manager = SecretaryManager.getInstance(101, true)
        const late = member(AHEAD, async () => false)
        const waiting = member(WAITING_A, async () => false)
        manager.shard = {
            CVSA: "seed",
            members: [late, waiting],
            validationPhases: {
                [AHEAD]: phase(3, true),
                [WAITING_A]: phase(3, true),
            },
            secretaryKey: OUR_KEY,
            blockRef: 101,
        } as any
        manager.ourValidatorPhase = phase(3, true) as any
        manager.blockTimestamp = 1_000
        // The peerlist is not merged yet, so the release awaits it; the
        // member reports phase 6 during that await.
        manager.mergedPeerlist = null
        manager.ensureMergedPeerlist = async () => {
            manager.shard.validationPhases[AHEAD] = phase(6, true) as any
            manager.mergedPeerlist = []
            return []
        }

        await manager.releaseWaitingMembers([AHEAD, WAITING_A], 3, "test")

        expect(late.longCall).not.toHaveBeenCalled()
        expect(manager.shard.validationPhases[AHEAD].waitStatus).toBe(true)
        expect(waiting.longCall).toHaveBeenCalledTimes(1)
        expect(manager.shard.validationPhases[WAITING_A].waitStatus).toBe(false)
    })

    test("a timeout that fires while a release is running reruns once it finishes", async () => {
        const manager = SecretaryManager.getInstance(101, true)
        let pings = 0
        const silent = member(SILENT_ONLINE, async () => {
            pings++
            await sleep(30)
            return true
        })
        // The first release's greenlight send is slow, like a peer that
        // accepts the connection but never answers.
        const slow = member(WAITING_A, async () => false)
        slow.longCall = jest.fn(async () => {
            await sleep(40)
            return { result: 200, response: "ok", require_reply: false, extra: null }
        })
        manager.shard = {
            CVSA: "seed",
            members: [silent, slow],
            validationPhases: {
                [SILENT_ONLINE]: phase(1, false),
                [WAITING_A]: phase(3, true),
            },
            secretaryKey: OUR_KEY,
            blockRef: 101,
        } as any
        manager.ourValidatorPhase = phase(3, true) as any
        manager.blockTimestamp = 1_000
        manager.mergedPeerlist = []
        manager.runSecretaryRoutine = true

        ;(manager as any).startTimeoutRelease()
        await sleep(5)
        // Second timeout while the first release is still pinging.
        ;(manager as any).startTimeoutRelease()
        expect(pings).toBe(1)

        // The next phase begins while the first release is still sending.
        setTimeout(() => {
            manager.ourValidatorPhase = phase(6, true) as any
            manager.shard.validationPhases[WAITING_A] = phase(6, true) as any
            manager.shard.validationPhases[SILENT_ONLINE] = phase(6, true) as any
        }, 50)

        await (manager as any).timeoutRelease
        // The queued release is now running.
        expect((manager as any).timeoutRelease).not.toBeNull()
        await (manager as any).timeoutRelease

        expect(pings).toBe(1)
        expect(slow.longCall).toHaveBeenCalledTimes(2)
        const phases = (slow.longCall.mock.calls as any[]).map(
            c => c[0].params[0].params[2],
        )
        expect(phases).toEqual([3, 6])
        expect((manager as any).timeoutRelease).toBeNull()
        expect((manager as any).timeoutReleaseQueued).toBe(false)
    })

    test("a queued timeout is dropped when the phase completes normally before it reruns", async () => {
        const manager = SecretaryManager.getInstance(101, true)
        const slow = member(WAITING_A, async () => false)
        slow.longCall = jest.fn(async () => {
            await sleep(40)
            return { result: 200, response: "ok", require_reply: false, extra: null }
        })
        const other = member(WAITING_B, async () => true)
        manager.shard = {
            CVSA: "seed",
            members: [slow, other],
            validationPhases: {
                [WAITING_A]: phase(1, true),
                [WAITING_B]: phase(1, true),
            },
            secretaryKey: OUR_KEY,
            blockRef: 101,
        } as any
        manager.ourValidatorPhase = phase(1, true) as any
        manager.blockTimestamp = 1_000
        manager.mergedPeerlist = []
        manager.runSecretaryRoutine = true

        ;(manager as any).startTimeoutRelease()
        await sleep(5)
        ;(manager as any).startTimeoutRelease()
        expect((manager as any).timeoutReleaseQueued).toBe(true)

        // Phase 2 completes the normal way while the first release is still
        // sending; then one member reports phase 4 and the other has not yet.
        await sleep(10)
        manager.ourValidatorPhase = phase(2, true) as any
        manager.shard.validationPhases[WAITING_A] = phase(2, true) as any
        manager.shard.validationPhases[WAITING_B] = phase(2, true) as any
        expect(await manager.releaseWaitingRoutine(true)).toBe(true)
        manager.ourValidatorPhase = phase(4, true) as any
        manager.shard.validationPhases[WAITING_A] = phase(4, true) as any
        manager.shard.validationPhases[WAITING_B] = phase(2, false) as any

        while ((manager as any).timeoutRelease) {
            await (manager as any).timeoutRelease
        }
        await sleep(60)

        expect((manager as any).timeoutReleaseQueued).toBe(false)
        // Phase 4 waits for its own timeout instead of a stale one.
        expect(manager.shard.validationPhases[WAITING_A].waitStatus).toBe(true)
        for (const m of [slow, other]) {
            const sent = (m.longCall.mock.calls as any[]).map(
                c => c[0].params[0].params[2],
            )
            expect(sent).not.toContain(4)
        }
    })

    test("a queued timeout is dropped once the secretary routine has ended", async () => {
        const manager = SecretaryManager.getInstance(101, true)
        const waiting = member(WAITING_A, async () => false)
        waiting.longCall = jest.fn(async () => {
            await sleep(20)
            return { result: 200, response: "ok", require_reply: false, extra: null }
        })
        manager.shard = {
            CVSA: "seed",
            members: [waiting],
            validationPhases: { [WAITING_A]: phase(6, true) },
            secretaryKey: OUR_KEY,
            blockRef: 101,
        } as any
        manager.ourValidatorPhase = phase(6, true) as any
        manager.blockTimestamp = 1_000
        manager.mergedPeerlist = []
        manager.runSecretaryRoutine = false

        ;(manager as any).startTimeoutRelease()
        ;(manager as any).startTimeoutRelease()
        await (manager as any).timeoutRelease

        expect(waiting.longCall).toHaveBeenCalledTimes(1)
        expect((manager as any).timeoutRelease).toBeNull()
        expect((manager as any).timeoutReleaseQueued).toBe(false)
    })

    test("sends nothing when every member moved on during the ping", async () => {
        const manager = SecretaryManager.getInstance(101, true)
        const ahead = member(AHEAD, async () => false)
        const silent = member(SILENT_ONLINE, async () => {
            await sleep(20)
            return true
        })
        manager.shard = {
            CVSA: "seed",
            members: [ahead, silent],
            validationPhases: {
                [AHEAD]: phase(3, true),
                [SILENT_ONLINE]: phase(1, false),
            },
            secretaryKey: OUR_KEY,
            blockRef: 101,
        } as any
        manager.ourValidatorPhase = phase(3, true) as any
        manager.blockTimestamp = 1_000
        manager.mergedPeerlist = []

        setTimeout(() => {
            manager.shard.validationPhases[AHEAD] = phase(6, true) as any
            manager.shard.validationPhases[SILENT_ONLINE] = phase(6, true) as any
        }, 5)

        await manager.releaseAfterTimeout()

        expect(ahead.longCall).not.toHaveBeenCalled()
        expect(silent.longCall).not.toHaveBeenCalled()
        expect(manager.shard.validationPhases[AHEAD].waitStatus).toBe(true)
        expect(manager.shard.validationPhases[SILENT_ONLINE].waitStatus).toBe(true)
    })
})
