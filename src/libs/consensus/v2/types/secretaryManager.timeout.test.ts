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

    test("a second timeout while a release is running does not start another", async () => {
        const manager = SecretaryManager.getInstance(101, true)
        let pings = 0
        const silent = member(SILENT_ONLINE, async () => {
            pings++
            await sleep(30)
            return true
        })
        manager.shard = {
            CVSA: "seed",
            members: [silent],
            validationPhases: { [SILENT_ONLINE]: phase(1, false) },
            secretaryKey: OUR_KEY,
            blockRef: 101,
        } as any
        manager.ourValidatorPhase = phase(3, true) as any
        manager.blockTimestamp = 1_000
        manager.mergedPeerlist = []

        ;(manager as any).startTimeoutRelease()
        ;(manager as any).startTimeoutRelease()
        await (manager as any).timeoutRelease

        expect(pings).toBe(1)
        expect(silent.longCall).toHaveBeenCalledTimes(1)
        expect((manager as any).timeoutRelease).toBeNull()
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
