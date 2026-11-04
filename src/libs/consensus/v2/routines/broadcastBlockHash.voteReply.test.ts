/**
 * The signatures a member attaches to its vote reply are merged into our
 * candidate, so they are held to the rule the inbound proposal and sync
 * apply: only the vote signer set counts, a map larger than that set is no
 * honest reply, and a set that cannot be resolved admits nothing. Under
 * commitLock the merged map is the proof of lock, which refuses a map
 * larger than twice the committee, so padding there would stall the height.
 * Real ed25519 throughout; only chain storage and the validator set are
 * stubbed.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import {
    type Signer,
    type StubChain,
    makeBlock,
    makeSigner,
    mockCommitteeChain,
} from "../../../../../testing/consensus/committeeTestKit"

const sharedState: Record<string, any> = {
    signingAlgorithm: "ed25519",
    shardSize: 4,
    publicKeyHex: "",
    lastBlockNumber: 9,
    lastBlockHash: "hash-9",
    genesisBlockHash: "hash-0",
    candidateBlock: null,
    forkConfig: {
        quorumParity: { activationHeight: 0 },
        committeeBinding: { activationHeight: 0 },
        commitLock: { activationHeight: null },
    },
    identity: { masterSeed: new Uint8Array(128).fill(9) },
}

const chain: StubChain = { peerlist: [], staked: null, tip: 9 }
mockCommitteeChain(sharedState, chain)

const { broadcastBlockHash } = await import("./broadcastBlockHash")
const { getBoundCommittee, __resetValidatorCache: resetPoolCache } = await import("./getShard")
const { proofOfLock } = await import("../commitLock/votes")
const { prevoteMessage } = await import("../commitLock/domain")
const validatorPool = (
    await import("src/libs/blockchain/validation/txValidatorPool")
).default.getInstance()

const ROUND = 1500

let signers: Signer[] = []
let throwaway: Signer[] = []
let members: Signer[] = []
let outsider: Signer
let block: any

const lockOn = () => {
    sharedState.forkConfig.commitLock.activationHeight = 0
    block.validation_data.round = ROUND
}
const voteMessage = () =>
    sharedState.forkConfig.commitLock.activationHeight === 0
        ? prevoteMessage(block.number, ROUND, block.hash)
        : block.hash

async function signaturesOf(...by: Signer[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {}
    for (const s of by) out[s.identity] = await s.sign(voteMessage())
    return out
}

/** A member answering 200 with `signatures` as its validation data. */
const replying = (identity: string, signatures: () => Promise<Record<string, string>>) => ({
    identity,
    longCall: async () => ({
        result: 200,
        response: identity,
        extra: { signatures: await signatures() },
    }),
})

const later = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const merged = () => Object.keys(block.validation_data.signatures).sort()
const ids = (...by: Signer[]) => by.map(s => s.identity).sort()

beforeAll(async () => {
    signers = await Promise.all(
        Array.from({ length: 6 }, (_, i) => makeSigner(`vote-reply-${i}`, i + 61)),
    )
    throwaway = await Promise.all(
        Array.from({ length: 10 }, (_, i) => makeSigner(`throwaway-${i}`, i + 161)),
    )
    await validatorPool.start(1)
})

afterAll(async () => {
    await validatorPool.stop()
})

beforeEach(async () => {
    resetPoolCache()
    sharedState.forkConfig.committeeBinding.activationHeight = 0
    sharedState.forkConfig.commitLock.activationHeight = null
    chain.peerlist = signers.map(s => s.identity)
    chain.staked = null
    chain.tip = 9
    const committee = await getBoundCommittee(9)
    members = committee.map(id => signers.find(s => s.identity === id))
    outsider = signers.find(s => !committee.includes(s.identity))
    sharedState.publicKeyHex = members[0].identity
    block = makeBlock("vote-reply")
    sharedState.candidateBlock = block
    block.validation_data.signatures = await signaturesOf(members[0])
})

describe("broadcastBlockHash keeps only the vote signer set from a reply", () => {
    it("merges honest replies, relayed member signatures included", async () => {
        const shard = [
            replying(members[1].identity, () => signaturesOf(members[1], members[2])),
            replying(members[2].identity, () => signaturesOf(members[2])),
            replying(members[3].identity, () => signaturesOf(members[3])),
        ]
        const [pro, con] = await broadcastBlockHash(block, shard as never)
        expect([pro, con]).toEqual([3, 0])
        expect(merged()).toEqual(ids(...members))
    })

    it("drops throwaway-key signatures from a reply and still counts its vote", async () => {
        const shard = [
            replying(members[1].identity, () =>
                signaturesOf(members[1], throwaway[0], throwaway[1]),
            ),
        ]
        const [pro, con] = await broadcastBlockHash(block, shard as never)
        expect([pro, con]).toEqual([1, 0])
        expect(merged()).toEqual(ids(members[0], members[1]))
    })

    it("drops a valid signature by a pool member outside the bound committee", async () => {
        const shard = [
            replying(members[1].identity, () => signaturesOf(members[1], outsider)),
        ]
        const [pro] = await broadcastBlockHash(block, shard as never)
        expect(pro).toBe(1)
        expect(merged()).toEqual(ids(members[0], members[1]))
    })

    it("counts a reply with more signatures than the signer set as con and merges none of it", async () => {
        const shard = [
            replying(members[1].identity, () => signaturesOf(members[1], ...throwaway)),
            replying(members[2].identity, () => signaturesOf(members[2])),
        ]
        const [pro, con] = await broadcastBlockHash(block, shard as never)
        expect([pro, con]).toEqual([1, 1])
        expect(merged()).toEqual(ids(members[0], members[2]))
    })

    it("admits no reply when the signer set cannot be resolved", async () => {
        chain.tip = 8
        const shard = [
            replying(members[1].identity, () => signaturesOf(members[1])),
            replying(members[2].identity, () => signaturesOf(members[2])),
        ]
        const [pro, con] = await broadcastBlockHash(block, shard as never)
        expect([pro, con]).toEqual([0, 2])
        expect(merged()).toEqual(ids(members[0]))
    })

    it("counts a 200 from a non-member as con: its own signature is not in the set", async () => {
        const shard = [
            replying(throwaway[0].identity, () => signaturesOf(throwaway[0], members[1])),
            replying(outsider.identity, () => signaturesOf(outsider, members[2])),
        ]
        const [pro, con] = await broadcastBlockHash(block, shard as never)
        expect([pro, con]).toEqual([0, 2])
        expect(merged()).toEqual(ids(members[0]))
    })

    it("accepts a reply carrying exactly as many signatures as the signer set holds", async () => {
        const shard = [replying(members[1].identity, () => signaturesOf(...members))]
        const [pro, con] = await broadcastBlockHash(block, shard as never)
        expect([pro, con]).toEqual([1, 0])
        expect(merged()).toEqual(ids(...members))
    })

    it("retries a failed signer-set lookup once for a later reply", async () => {
        chain.tip = 8
        const shard = [
            replying(members[1].identity, () => signaturesOf(members[1])),
            replying(members[2].identity, async () => {
                await later(50)
                chain.tip = 9
                return signaturesOf(members[2])
            }),
        ]
        const [pro, con] = await broadcastBlockHash(block, shard as never)
        expect([pro, con]).toEqual([1, 1])
        expect(merged()).toEqual(ids(members[0], members[2]))
    })

    it("admits nothing more once the retry has failed too", async () => {
        chain.tip = 8
        const shard = [
            replying(members[1].identity, () => signaturesOf(members[1])),
            replying(members[2].identity, async () => {
                await later(50)
                return signaturesOf(members[2])
            }),
            replying(members[3].identity, async () => {
                await later(100)
                chain.tip = 9
                return signaturesOf(members[3])
            }),
        ]
        const [pro, con] = await broadcastBlockHash(block, shard as never)
        expect([pro, con]).toEqual([0, 3])
        expect(merged()).toEqual(ids(members[0]))
    })

    it("keeps pool signatures and drops throwaway keys before committeeBinding", async () => {
        sharedState.forkConfig.committeeBinding.activationHeight = null
        sharedState.forkConfig.quorumParity.activationHeight = null
        try {
            const shard = [
                replying(members[1].identity, () =>
                    signaturesOf(members[1], outsider, throwaway[0]),
                ),
            ]
            const [pro] = await broadcastBlockHash(block, shard as never)
            expect(pro).toBe(1)
            expect(merged()).toEqual(ids(members[0], members[1], outsider))
        } finally {
            sharedState.forkConfig.quorumParity.activationHeight = 0
        }
    })
})

describe("broadcastBlockHash under commitLock", () => {
    it("keeps a proof of lock when one member pads its reply", async () => {
        lockOn()
        block.validation_data.signatures = await signaturesOf(members[0])
        const shard = [
            replying(members[1].identity, () => signaturesOf(members[1])),
            replying(members[2].identity, () => signaturesOf(members[2])),
            replying(members[3].identity, () => signaturesOf(members[3], ...throwaway)),
        ]
        await broadcastBlockHash(block, shard as never)

        const pol = await proofOfLock(
            block.number,
            ROUND,
            block.hash,
            block.validation_data.signatures,
            members.map(m => m.identity),
        )
        expect(pol).not.toBeNull()
        expect(Object.keys(pol).sort()).toEqual(ids(members[0], members[1], members[2]))
    })

    it("keeps a proof of lock when the padding fits under the committee size", async () => {
        lockOn()
        block.validation_data.signatures = await signaturesOf(members[0])
        const shard = [
            replying(members[1].identity, () => signaturesOf(members[1])),
            replying(members[2].identity, () =>
                signaturesOf(members[2], throwaway[0], throwaway[1], throwaway[2]),
            ),
        ]
        const [pro] = await broadcastBlockHash(block, shard as never)
        expect(pro).toBe(2)
        expect(merged()).toEqual(ids(members[0], members[1], members[2]))
    })
})
