/**
 * Undoing an identity edit (isRollback) must leave the account exactly as it
 * was before the edit. The remove edits name a link without carrying it, so
 * undoing one relies on what this node recorded when it applied the remove.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { cloneDefaultForkConfig } from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"
import Hashing from "@/libs/crypto/hashing"
import GCRIdentityRoutines from "./GCRIdentityRoutines"
import { IncentiveManager } from "./IncentiveManager"
import type { EditPlace, RemovedIdentities } from "./routines/removedIdentities"

const ACCOUNT = "0x" + "11".repeat(32)
const PROOF = "https://x.com/alice/status/1"

let saved: { forkConfig: any; lastBlockNumber: number }
beforeEach(() => {
    saved = {
        forkConfig: getSharedState.forkConfig,
        lastBlockNumber: getSharedState.lastBlockNumber,
    }
    getSharedState.forkConfig = cloneDefaultForkConfig()
    getSharedState.lastBlockNumber = 500
})
afterEach(() => {
    getSharedState.forkConfig = saved.forkConfig
    getSharedState.lastBlockNumber = saved.lastBlockNumber
})

let txCounter = 0
const nextHash = () => (++txCounter).toString(16).padStart(64, "0")

function account(): any {
    return {
        pubkey: ACCOUNT,
        identities: {
            xm: {
                evm: {
                    mainnet: [
                        {
                            address: "0x" + "aa".repeat(20),
                            signature: "0xsig-a",
                            publicKey: "",
                            timestamp: 1,
                            signedData: "a",
                        },
                    ],
                },
            },
            web2: {
                twitter: [
                    {
                        username: "carol",
                        userId: "7",
                        proof: "https://x.com/carol/status/7",
                        proofHash: Hashing.sha256("https://x.com/carol/status/7"),
                        timestamp: 1,
                    },
                ],
                github: [{ username: "alice", userId: 99, proof: "p", proofHash: "h", timestamp: 1 }],
            },
            pqc: {},
            ud: [],
        },
    }
}

function edit(context: string, operation: string, data: unknown, txhash = nextHash()): any {
    return {
        type: "identity",
        operation,
        context,
        account: ACCOUNT,
        txhash,
        isRollback: false,
        referralCode: null,
        data,
    }
}

const web2Add = (username: string, userId: unknown) =>
    edit("web2", "add", {
        context: "twitter",
        data: {
            username,
            userId,
            proof: PROOF,
            proofHash: Hashing.sha256(PROOF),
            timestamp: 5,
        },
    })

const xmAdd = (targetAddress: string) =>
    edit("xm", "add", {
        chain: "evm",
        subchain: "mainnet",
        isEVM: true,
        chainId: 1,
        targetAddress,
        signature: "0xsig-new",
        signedData: "signed",
        publicKey: "",
        timestamp: 5,
    })

/** The records of one block apply, as handleGCR keeps them in its caches. */
let records: RemovedIdentities
beforeEach(() => {
    records = new Map()
})
const placeOf = (e: any, position = 1): EditPlace => ({
    txhash: e.txhash,
    position,
    removed: records,
})

/** A block apply of the edit at `position` in its transaction. */
const apply = (e: any, acc: any, position = 1) =>
    GCRIdentityRoutines.apply(
        structuredClone(e),
        acc,
        undefined,
        undefined,
        placeOf(e, position),
    )

/** What the node does with an edit the block already applied, on undo. */
const undo = (e: any, acc: any, position = 1) =>
    GCRIdentityRoutines.apply(
        { ...structuredClone(e), isRollback: true },
        acc,
        undefined,
        undefined,
        placeOf(e, position),
    )

describe("undoing a web2 link", () => {
    it("removes exactly the link the add put there", async () => {
        const acc = account()
        const before = structuredClone(acc.identities)
        const add = web2Add("alice", "42")

        const applied = await apply(add, acc)
        expect(applied.success).toBe(true)
        expect(acc.identities.web2.twitter).toHaveLength(2)

        const undone = await undo(add, acc)

        expect(undone.success).toBe(true)
        expect(acc.identities).toEqual(before)
    })

    it("keeps another link that shares the username but not the account id", async () => {
        const acc = account()
        acc.identities.web2.twitter.push({
            username: "alice",
            userId: "41",
            proof: "old",
            proofHash: "old",
            timestamp: 2,
        })
        const before = structuredClone(acc.identities)
        const add = web2Add("alice", "42")

        expect((await apply(add, acc)).success).toBe(true)
        expect((await undo(add, acc)).success).toBe(true)

        expect(acc.identities).toEqual(before)
    })

    it("fails when the link is not there, changing nothing", async () => {
        const acc = account()
        const before = structuredClone(acc.identities)

        const undone = await undo(web2Add("nobody", "1"), acc)

        expect(undone.success).toBe(false)
        expect(acc.identities).toEqual(before)
    })
})

describe("the points an undone web2 link takes back", () => {
    let spy: ReturnType<typeof spyOn> | undefined
    const unlinked = () => (spy = spyOn(IncentiveManager, "twitterUnlinked").mockResolvedValue(undefined as never))
    afterEach(() => spy?.mockRestore())

    it("are none while another link of the context remains: they are that link's", async () => {
        const acc = account()
        const add = web2Add("alice", "42")
        expect((await apply(add, acc)).success).toBe(true)
        const spy = unlinked()

        const undone = await undo(add, acc)
        await undone.sideEffect?.()

        expect(undone.success).toBe(true)
        expect(spy).not.toHaveBeenCalled()
    })

    it("are the context's when the undone link was its only one", async () => {
        const acc = account()
        acc.identities.web2.twitter = []
        const add = web2Add("alice", "42")
        expect((await apply(add, acc)).success).toBe(true)
        const spy = unlinked()

        const undone = await undo(add, acc)
        await undone.sideEffect?.()

        expect(spy).toHaveBeenCalledTimes(1)
        expect(spy).toHaveBeenCalledWith(ACCOUNT)
    })
})

describe("undoing a web2 unlink", () => {
    it("puts the removed link back as it was, in its place", async () => {
        const acc = account()
        acc.identities.web2.twitter.push({
            username: "dave",
            userId: "8",
            proof: "https://x.com/dave/status/8",
            proofHash: "hd",
            timestamp: 3,
        })
        const before = structuredClone(acc.identities)
        const remove = edit("web2", "remove", { context: "twitter", username: "carol" })

        const applied = await apply(remove, acc)
        expect(applied.success).toBe(true)
        expect(acc.identities.web2.twitter.map((i: any) => i.username)).toEqual(["dave"])

        const undone = await undo(remove, acc)

        expect(undone.success).toBe(true)
        expect(acc.identities).toEqual(before)
    })

    it("fails without a record of what that unlink removed, changing nothing", async () => {
        const acc = account()
        const remove = edit("web2", "remove", { context: "twitter", username: "carol" })
        expect((await apply(remove, acc)).success).toBe(true)
        const after = structuredClone(acc.identities)

        const other = { ...structuredClone(remove), txhash: nextHash() }
        const undone = await undo(other, acc)

        expect(undone.success).toBe(false)
        expect(acc.identities).toEqual(after)
    })
})

describe("undoing a cross-chain link", () => {
    it("removes exactly the address the add put there", async () => {
        const acc = account()
        const before = structuredClone(acc.identities)
        const add = xmAdd("0x" + "BB".repeat(20))

        expect((await apply(add, acc)).success).toBe(true)
        expect(acc.identities.xm.evm.mainnet).toHaveLength(2)

        const undone = await undo(add, acc)

        expect(undone.success).toBe(true)
        expect(acc.identities).toEqual(before)
    })

    it("finds the address by the display form the add stored", async () => {
        const acc = account()
        const before = structuredClone(acc.identities)
        const add = edit("xm", "add", {
            ...xmAdd("raw-form").data,
            chain: "near",
            subchain: "mainnet",
            isEVM: false,
            displayAddress: "alice.near",
        })

        expect((await apply(add, acc)).success).toBe(true)
        expect(acc.identities.xm.near.mainnet[0].address).toBe("alice.near")
        expect((await undo(add, acc)).success).toBe(true)

        expect(acc.identities.xm.near.mainnet).toEqual([])
        expect({ ...acc.identities, xm: { evm: acc.identities.xm.evm } }).toEqual(before)
    })

    it("leaves the chain/subchain lists the add created, empty", async () => {
        const acc = account()
        const add = edit("xm", "add", {
            ...xmAdd("SoLaNaAddr").data,
            chain: "solana",
            subchain: "mainnet",
            isEVM: false,
        })

        expect((await apply(add, acc)).success).toBe(true)
        expect((await undo(add, acc)).success).toBe(true)

        expect(acc.identities.xm.solana.mainnet).toEqual([])
    })
})

describe("undoing a cross-chain unlink", () => {
    it("puts the removed address back with its signature, in its place", async () => {
        const acc = account()
        acc.identities.xm.evm.mainnet.push({
            address: "0x" + "cc".repeat(20),
            signature: "0xsig-c",
            publicKey: "",
            timestamp: 2,
            signedData: "c",
        })
        const before = structuredClone(acc.identities)
        const remove = edit("xm", "remove", {
            chain: "evm",
            subchain: "mainnet",
            isEVM: true,
            targetAddress: "0x" + "AA".repeat(20),
        })

        const applied = await apply(remove, acc)
        expect(applied.success).toBe(true)
        expect(acc.identities.xm.evm.mainnet).toHaveLength(1)

        const undone = await undo(remove, acc)

        expect(undone.success).toBe(true)
        expect(acc.identities).toEqual(before)
    })

    it("fails without a record of what that unlink removed, changing nothing", async () => {
        const acc = account()
        const remove = edit("xm", "remove", {
            chain: "evm",
            subchain: "mainnet",
            isEVM: true,
            targetAddress: "0x" + "aa".repeat(20),
        })
        expect((await apply(remove, acc)).success).toBe(true)
        const after = structuredClone(acc.identities)

        const undone = await undo({ ...structuredClone(remove), txhash: nextHash() }, acc)

        expect(undone.success).toBe(false)
        expect(acc.identities).toEqual(after)
    })
})

describe("applying links and unlinks", () => {
    it("is unchanged: add appends the signed data, remove filters it out", async () => {
        const acc = account()
        const add = web2Add("alice", "42")
        await apply(add, acc)
        expect(acc.identities.web2.twitter.at(-1)).toEqual(add.data.data)

        const xm = xmAdd("0x" + "BB".repeat(20))
        await apply(xm, acc)
        expect(acc.identities.xm.evm.mainnet.at(-1)).toEqual({
            address: "0x" + "bb".repeat(20),
            signature: "0xsig-new",
            publicKey: "",
            timestamp: 5,
            signedData: "signed",
        })

        await apply(
            edit("web2", "remove", { context: "twitter", username: "alice" }),
            acc,
        )
        expect(acc.identities.web2.twitter.map((i: any) => i.username)).toEqual(["carol"])
    })
})

describe("undo records", () => {
    const remove = () =>
        edit("web2", "remove", { context: "twitter", username: "carol" })

    it("are not written by a simulation, which has no place", async () => {
        const acc = account()
        const e = remove()

        const simulated = await GCRIdentityRoutines.apply(structuredClone(e), acc)

        expect(simulated.success).toBe(true)
        expect(records.size).toBe(0)
        expect((await undo(e, acc)).success).toBe(false)
    })

    it("keep each unlink of one link in one transaction apart", async () => {
        const acc = account()
        const before = structuredClone(acc.identities)
        const first = remove()
        const relink = {
            ...edit("web2", "add", {
                context: "twitter",
                data: {
                    username: "carol",
                    userId: "7",
                    proof: PROOF,
                    proofHash: Hashing.sha256(PROOF),
                    timestamp: 9,
                },
            }),
            txhash: first.txhash,
        }
        const second = { ...remove(), txhash: first.txhash }

        expect((await apply(first, acc, 1)).success).toBe(true)
        expect((await apply(relink, acc, 2)).success).toBe(true)
        const relinked = structuredClone(acc.identities)
        expect((await apply(second, acc, 3)).success).toBe(true)

        expect((await undo(second, acc, 3)).success).toBe(true)
        expect(acc.identities).toEqual(relinked)
        expect((await undo(relink, acc, 2)).success).toBe(true)
        expect((await undo(first, acc, 1)).success).toBe(true)
        expect(acc.identities).toEqual(before)
    })
})
