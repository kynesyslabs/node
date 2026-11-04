/**
 * Undoing an identity edit (isRollback) must leave the account exactly as it
 * was before the edit. The remove edits name a link without carrying it, so
 * undoing one relies on what this node recorded when it applied the remove.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { cloneDefaultForkConfig } from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"
import Hashing from "@/libs/crypto/hashing"
import GCRIdentityRoutines from "./GCRIdentityRoutines"

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

/** What the node does with an edit the block already applied, on undo. */
const undo = (e: any, acc: any) =>
    GCRIdentityRoutines.apply({ ...structuredClone(e), isRollback: true }, acc)

describe("undoing a web2 link", () => {
    it("removes exactly the link the add put there", async () => {
        const acc = account()
        const before = structuredClone(acc.identities)
        const add = web2Add("alice", "42")

        const applied = await GCRIdentityRoutines.apply(structuredClone(add), acc)
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

        expect((await GCRIdentityRoutines.apply(structuredClone(add), acc)).success).toBe(true)
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

        const applied = await GCRIdentityRoutines.apply(structuredClone(remove), acc)
        expect(applied.success).toBe(true)
        expect(acc.identities.web2.twitter.map((i: any) => i.username)).toEqual(["dave"])

        const undone = await undo(remove, acc)

        expect(undone.success).toBe(true)
        expect(acc.identities).toEqual(before)
    })

    it("fails without a record of what that unlink removed, changing nothing", async () => {
        const acc = account()
        const remove = edit("web2", "remove", { context: "twitter", username: "carol" })
        expect((await GCRIdentityRoutines.apply(structuredClone(remove), acc)).success).toBe(true)
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

        expect((await GCRIdentityRoutines.apply(structuredClone(add), acc)).success).toBe(true)
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

        expect((await GCRIdentityRoutines.apply(structuredClone(add), acc)).success).toBe(true)
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

        expect((await GCRIdentityRoutines.apply(structuredClone(add), acc)).success).toBe(true)
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

        const applied = await GCRIdentityRoutines.apply(structuredClone(remove), acc)
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
        expect((await GCRIdentityRoutines.apply(structuredClone(remove), acc)).success).toBe(true)
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
        await GCRIdentityRoutines.apply(structuredClone(add), acc)
        expect(acc.identities.web2.twitter.at(-1)).toEqual(add.data.data)

        const xm = xmAdd("0x" + "BB".repeat(20))
        await GCRIdentityRoutines.apply(structuredClone(xm), acc)
        expect(acc.identities.xm.evm.mainnet.at(-1)).toEqual({
            address: "0x" + "bb".repeat(20),
            signature: "0xsig-new",
            publicKey: "",
            timestamp: 5,
            signedData: "signed",
        })

        await GCRIdentityRoutines.apply(
            edit("web2", "remove", { context: "twitter", username: "alice" }),
            acc,
        )
        expect(acc.identities.web2.twitter.map((i: any) => i.username)).toEqual(["carol"])
    })
})
