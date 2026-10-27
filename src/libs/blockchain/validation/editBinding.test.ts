/**
 * What the edit binding refuses, and the explicit exceptions it keeps.
 *
 * Each forged transaction starts from one the SDK built and signed, then has
 * its shipped edits changed the way a peer with its own key could change them:
 * the signature covers the edits, but the peer signs whatever it ships.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test"

mock.module("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: { getLastBlockNumber: async () => 100 },
}))
mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: () => {},
        info: () => {},
        warning: () => {},
        error: () => {},
        only: () => {},
    },
}))

import { DemosTransactions } from "@kynesyslabs/demosdk/websdk"
import { StorageProgram } from "@kynesyslabs/demosdk/storage"
import { Identities } from "@kynesyslabs/demosdk/abstraction"
import type { GCREdit, Transaction } from "@kynesyslabs/demosdk/types"
import { getSharedState } from "@/utilities/sharedState"
import {
    verifyAdmissionEdits,
    verifyEditsAgainstBody,
    verifyEditsAtApply,
    verifySenderBinding,
} from "./editBinding"
import { OS, PEER, SENDER, VICTIM, chainIs, demos, handMade, onTheWire, viaConfirm } from "./editBinding.fixtures"

const identities = new Identities()
const SUDO = "0x" + "5d".repeat(32)

/** What block 0 committed, as the node holds it after boot. */
function pinAwardSigner(pubkey: string | null) {
    ;(getSharedState as any)._genesisSudoPubkey = pubkey
}

const storageProgram = StorageProgram.createStorageProgram(SENDER, "probe", { a: 1 }, "json", undefined, { nonce: 1 })
const storageAddress = storageProgram.storageAddress

const builders = {
    native: () => DemosTransactions.pay(PEER, 3n * OS, demos),
    storageWrite: () => demos.storagePrograms.sign(StorageProgram.writeStorage(storageAddress, { a: 2 }, "json")),
    unstake: () => DemosTransactions.unstake(demos),
    stake: () => DemosTransactions.stake("5000000000", "https://node.example", demos),
    vote: () => DemosTransactions.voteOnUpgrade("11111111-1111-4111-8111-111111111111", true, demos),
    proposal: () =>
        DemosTransactions.proposeNetworkUpgrade(
            {
                proposalId: "11111111-1111-4111-8111-111111111111",
                proposedParameters: { networkFee: 2 } as never,
                rationale: "r",
                effectiveAtBlock: 5000,
            },
            demos,
        ),
    identityXm: () =>
        viaConfirm(() =>
            identities.inferXmIdentity(
                demos,
                {
                    target_identity: {
                        chain: "evm",
                        subchain: "mainnet",
                        isEVM: true,
                        chainId: 1,
                        targetAddress: "0x" + "ee".repeat(20),
                        signature: "0x12",
                        publicKey: "0x34",
                    },
                } as never,
                "ref1",
            ),
        ),
}

async function wire(kind: keyof typeof builders): Promise<Transaction> {
    return onTheWire(await builders[kind]())
}

const edits = (tx: Transaction) => tx.content.gcr_edits as unknown as Array<Record<string, any>>

/** Both places a transaction is judged: pool admission and block apply. */
async function refusedEverywhere(tx: Transaction) {
    for (const post of [true, false]) {
        chainIs(post)
        expect((await verifyAdmissionEdits(tx)).ok).toBe(false)
        expect((await verifyEditsAtApply(tx)).ok).toBe(false)
    }
}

beforeEach(() => chainIs(true))

describe("a forged edit shipped by a peer that signed the transaction itself", () => {
    it("a nonce bump on another account", async () => {
        const tx = await wire("unstake")
        edits(tx).push({ type: "nonce", operation: "add", account: VICTIM, amount: 1000, isRollback: false, txhash: "" })
        await refusedEverywhere(tx)
    })

    it("a vote recorded under another validator", async () => {
        const tx = await wire("vote")
        const vote = edits(tx).find(e => e.type === "networkUpgradeVote")!
        vote.account = VICTIM
        await refusedEverywhere(tx)
    })

    it("a proposal recorded under another validator", async () => {
        const tx = await wire("proposal")
        edits(tx).find(e => e.type === "networkUpgrade")!.account = VICTIM
        await refusedEverywhere(tx)
    })

    it("a stake recorded for another account", async () => {
        const tx = await wire("stake")
        edits(tx).find(e => e.type === "validatorStake")!.account = VICTIM
        await refusedEverywhere(tx)
    })

    it("a storage write naming another sender", async () => {
        const tx = await wire("storageWrite")
        edits(tx).find(e => e.type === "storageProgram")!.context.sender = VICTIM
        await refusedEverywhere(tx)
    })

    it("an identity attached to another account", async () => {
        const tx = await wire("identityXm")
        edits(tx).find(e => e.type === "identity")!.account = VICTIM
        await refusedEverywhere(tx)
    })

    it("a points credit riding on a transaction that is not an award", async () => {
        const tx = await wire("storageWrite")
        edits(tx).push({
            type: "identity",
            context: "points",
            isRollback: false,
            operation: "add",
            account: SENDER,
            amount: 1_000_000,
            date: new Date().toISOString(),
            txhash: "",
        })
        await refusedEverywhere(tx)
    })

    it("a balance credit on a non-native transaction", async () => {
        const tx = await wire("unstake")
        edits(tx).push({ type: "balance", operation: "add", account: SENDER, amount: String(1_000_000n * OS), isRollback: false, txhash: "" })
        await refusedEverywhere(tx)
    })

    it("a balance credit on a native transaction", async () => {
        const tx = await wire("native")
        edits(tx).push({ type: "balance", operation: "add", account: SENDER, amount: String(1_000_000n * OS), isRollback: false, txhash: "" })
        await refusedEverywhere(tx)
    })

    it("a TLSNotary proof store, which no generator emits", async () => {
        const tx = await wire("unstake")
        edits(tx).push({
            type: "tlsnotary",
            operation: "store",
            account: VICTIM,
            data: { tokenId: "t", domain: "d", proof: "p", storageType: "onchain", timestamp: 1 },
            isRollback: false,
            txhash: "",
        })
        await refusedEverywhere(tx)
    })

    it("a dropped gas edit, which would make the transaction free", async () => {
        const tx = await wire("unstake")
        tx.content.gcr_edits = edits(tx).filter(e => e.type !== "balance") as unknown as GCREdit[]
        await refusedEverywhere(tx)
    })

    it("the same edits in another order", async () => {
        const tx = await wire("native")
        tx.content.gcr_edits = [...edits(tx)].reverse() as unknown as GCREdit[]
        await refusedEverywhere(tx)
    })

    it("an edit of a kind nothing regenerates", async () => {
        const tx = await wire("unstake")
        edits(tx).push({ type: "mystery", account: SENDER, isRollback: false, txhash: "" })
        await refusedEverywhere(tx)
    })

    it("does not change the transaction it checks", async () => {
        const tx = await wire("storageWrite")
        edits(tx).push({ type: "nonce", operation: "add", account: VICTIM, amount: 1, isRollback: false, txhash: "" })
        const before = JSON.stringify(tx)
        await verifyAdmissionEdits(tx)
        await verifyEditsAtApply(tx)
        expect(JSON.stringify(tx)).toBe(before)
    })

    it("is not fooled by edits that differ only in key order or in the stamped txhash", async () => {
        const tx = await wire("storageWrite")
        tx.content.gcr_edits = edits(tx).map(e => {
            const reordered: Record<string, unknown> = {}
            for (const k of Object.keys(e).reverse()) reordered[k] = e[k]
            reordered.txhash = tx.hash
            return reordered
        }) as unknown as GCREdit[]
        expect((await verifyAdmissionEdits(tx)).ok).toBe(true)
        expect((await verifyEditsAtApply(tx)).ok).toBe(true)
    })
})

describe("an amount is judged in the shape apply will use", () => {
    it("refuses a gas edit shipped as a DEM number after osDenomination, which would be applied as 1 OS", async () => {
        chainIs(true)
        const tx = await wire("storageWrite")
        const gas = edits(tx).find(e => e.type === "balance" && e.operation === "remove")!
        expect(gas.amount).toBe("1000000000")
        gas.amount = 1
        expect((await verifyAdmissionEdits(tx)).ok).toBe(false)
        expect((await verifyEditsAtApply(tx)).ok).toBe(false)
    })

    it("refuses the same on a native transaction, at admission and at apply", async () => {
        chainIs(true)
        const tx = await wire("native")
        const gas = edits(tx).filter(e => e.type === "balance" && e.operation === "remove")[1]
        gas.amount = 1
        expect((await verifyAdmissionEdits(tx)).ok).toBe(false)
        expect((await verifyEditsAtApply(tx)).ok).toBe(false)
    })

    it("refuses a gas edit shipped as an OS string before osDenomination, which would be applied in full", async () => {
        chainIs(false)
        const tx = await wire("storageWrite")
        const gas = edits(tx).find(e => e.type === "balance" && e.operation === "remove")!
        gas.amount = "1000000000"
        expect((await verifyAdmissionEdits(tx)).ok).toBe(false)
        expect((await verifyEditsAtApply(tx)).ok).toBe(false)
    })

    for (const bad of ["abc", "", -1, null, { os: "1" }, 1.5]) {
        it(`refuses, without throwing, a shipped amount of ${JSON.stringify(bad)}`, async () => {
            chainIs(true)
            const tx = await wire("storageWrite")
            edits(tx).find(e => e.type === "balance")!.amount = bad
            expect((await verifyAdmissionEdits(tx)).ok).toBe(false)
            expect((await verifyEditsAtApply(tx)).ok).toBe(false)
        })
    }

    it("refuses a transaction whose edits cannot be regenerated", async () => {
        const tx = await wire("identityXm")
        ;(tx.content.data as unknown as [string, Record<string, unknown>])[1].method = "unheard_of_method"
        await refusedEverywhere(tx)
    })

    it("refuses a transaction with no edits at all when the body implies some", async () => {
        const tx = await wire("unstake")
        tx.content.gcr_edits = []
        await refusedEverywhere(tx)
    })
})

describe("sender binding", () => {
    const sender = (over: Record<string, unknown> = {}): Transaction =>
        ({
            hash: "ab".repeat(32),
            content: { type: "validatorUnstake", from: SENDER, from_ed25519_address: SENDER, gcr_edits: [], ...over },
        }) as unknown as Transaction

    const cases: Array<[string, Record<string, unknown>]> = [
        ["nonce", { type: "nonce", operation: "add", account: VICTIM, amount: 1 }],
        ["networkUpgrade", { type: "networkUpgrade", account: VICTIM, proposalId: "p" }],
        ["networkUpgradeVote", { type: "networkUpgradeVote", account: VICTIM, proposalId: "p", approve: true }],
        ["validatorStake", { type: "validatorStake", account: VICTIM, operation: "stake", amount: "1" }],
        ["tlsnotary", { type: "tlsnotary", operation: "store", account: VICTIM, data: {} }],
        ["identity", { type: "identity", context: "xm", operation: "add", account: VICTIM, data: {} }],
        ["storageProgram", { type: "storageProgram", target: storageAddress, context: { sender: VICTIM, operation: "WRITE_STORAGE" } }],
    ]

    for (const [name, edit] of cases) {
        it(`refuses a ${name} edit on another account and accepts it on the sender's`, () => {
            const foreign = sender({ gcr_edits: [{ ...edit }] })
            expect(verifySenderBinding(foreign).ok).toBe(false)

            const own =
                name === "storageProgram"
                    ? { ...edit, context: { ...(edit.context as object), sender: SENDER } }
                    : { ...edit, account: SENDER }
            expect(verifySenderBinding(sender({ gcr_edits: [own] })).ok).toBe(true)
        })
    }

    it("leaves balance edits alone: paying another account is what a transfer is", () => {
        const tx = sender({ gcr_edits: [{ type: "balance", operation: "add", account: VICTIM, amount: "1" }] })
        expect(verifySenderBinding(tx).ok).toBe(true)
    })

    it("accepts a Telegram link, which the bot signs for the user's account", async () => {
        chainIs(true)
        const tx = await wire("identityXm")
        const link = await viaConfirm(() =>
            identities.inferWeb2Identity(demos, {
                context: "telegram",
                proof: {
                    payload: { telegram_user_id: "42", username: "alice", public_key: VICTIM, timestamp: 1 },
                    signature: "0x01",
                },
                username: "alice",
                userId: "42",
            } as never),
        )
        expect(tx).toBeDefined()
        const shipped = onTheWire(link)
        expect(edits(shipped).find(e => e.type === "identity")!.account).toBe(VICTIM)
        expect(shipped.content.from_ed25519_address).toBe(SENDER)

        expect((await verifyEditsAtApply(shipped)).ok).toBe(true)
        expect((await verifyAdmissionEdits(shipped)).ok).toBe(true)
    })

    it("refuses a Telegram-shaped edit that the signed body does not imply", async () => {
        chainIs(true)
        const link = onTheWire(
            await viaConfirm(() =>
                identities.inferWeb2Identity(demos, {
                    context: "telegram",
                    proof: {
                        payload: { telegram_user_id: "42", username: "alice", public_key: VICTIM, timestamp: 1 },
                        signature: "0x01",
                    },
                    username: "alice",
                    userId: "42",
                } as never),
            ),
        )
        edits(link).find(e => e.type === "identity")!.account = "0x" + "77".repeat(32)
        await refusedEverywhere(link)
    })

    it("accepts an account written without the prefix the generator adds", () => {
        const bare = SENDER.slice(2)
        const tx = sender({
            from: bare,
            from_ed25519_address: bare,
            gcr_edits: [{ type: "nonce", operation: "add", account: SENDER, amount: 1 }],
        })
        expect(verifySenderBinding(tx).ok).toBe(true)
    })

    it("refuses an account-bound edit when the transaction names no sender", () => {
        const tx = sender({
            from: "",
            from_ed25519_address: "",
            gcr_edits: [{ type: "nonce", operation: "add", account: SENDER, amount: 1 }],
        })
        expect(verifySenderBinding(tx).ok).toBe(false)
    })
})

describe("the award transaction", () => {
    const accounts = [
        { platform: "twitter", username: "alice", points: 10, lookup: "web2.twitter.alice", address: VICTIM, comment: "Account found. Points awarded." },
        { platform: "twitter", username: "bob", points: 5, lookup: "web2.twitter.bob", address: null, comment: "Account not found. Points NOT awarded." },
        { address: PEER, points: "7", lookup: `native.${PEER}`, comment: "Account found. Points awarded." },
    ]
    const date = "2026-10-27T10:00:00.000Z"
    const credit = (account: string, amount: number, over: Record<string, unknown> = {}) => ({
        type: "identity",
        context: "points",
        isRollback: false,
        operation: "add",
        account,
        amount,
        date,
        txhash: "",
        ...over,
    })
    const award = (over: Record<string, unknown> = {}, edits?: unknown[]): Transaction =>
        ({
            hash: "cd".repeat(32),
            content: {
                type: "identity",
                from: SUDO,
                to: SUDO,
                from_ed25519_address: SUDO,
                amount: 0,
                nonce: 1,
                timestamp: Date.now(),
                data: ["awardPoints", structuredClone(accounts)],
                gcr_edits: edits ?? [credit(VICTIM, 10), credit(PEER, 7)],
                ...over,
            },
        }) as unknown as Transaction

    beforeEach(() => {
        pinAwardSigner(SUDO)
        ;(getSharedState as any).SUDO_PUBKEY = null
    })

    it("is accepted from the SUDO key with exactly the credits its data implies", async () => {
        expect(await verifyAdmissionEdits(award())).toEqual({ ok: true })
        expect(await verifyEditsAtApply(award())).toEqual({ ok: true })
    })

    it("is accepted after apply stamped its edits with the transaction hash", async () => {
        const tx = award({}, [credit(VICTIM, 10, { txhash: "cd".repeat(32) }), credit(PEER, 7, { txhash: "cd".repeat(32) })])
        expect((await verifyEditsAtApply(tx)).ok).toBe(true)
    })

    it("is refused when signed by any other key", async () => {
        const tx = award({ from: SENDER, from_ed25519_address: SENDER })
        expect((await verifyAdmissionEdits(tx)).ok).toBe(false)
        expect((await verifyEditsAtApply(tx)).ok).toBe(false)
    })

    it("is refused when genesis names no award signer", async () => {
        pinAwardSigner(null)
        expect((await verifyAdmissionEdits(award())).ok).toBe(false)
        expect((await verifyEditsAtApply(award())).ok).toBe(false)
    })

    it("is decided by genesis alone, whatever the node's own SUDO_PUBKEY says", async () => {
        // A node configured with the signer's key still refuses when genesis names no signer.
        pinAwardSigner(null)
        ;(getSharedState as any).SUDO_PUBKEY = SUDO
        expect((await verifyEditsAtApply(award())).ok).toBe(false)

        // A node configured with another key still accepts what genesis allows.
        pinAwardSigner(SUDO)
        for (const configured of [null, "", SENDER, VICTIM]) {
            ;(getSharedState as any).SUDO_PUBKEY = configured
            expect((await verifyEditsAtApply(award())).ok).toBe(true)
            expect((await verifyAdmissionEdits(award())).ok).toBe(true)
        }

        // And a transaction signed by the configured key, but not by genesis's, is refused.
        ;(getSharedState as any).SUDO_PUBKEY = SENDER
        expect((await verifyEditsAtApply(award({ from: SENDER, from_ed25519_address: SENDER }))).ok).toBe(false)
    })

    it("is refused with a credit its data does not imply", async () => {
        const extra = award({}, [credit(VICTIM, 10), credit(PEER, 7), credit(SENDER, 1_000_000)])
        expect((await verifyAdmissionEdits(extra)).ok).toBe(false)
        expect((await verifyEditsAtApply(extra)).ok).toBe(false)
    })

    it("is refused with a credit for the wrong amount or the wrong account", async () => {
        for (const edits of [
            [credit(VICTIM, 11), credit(PEER, 7)],
            [credit(SENDER, 10), credit(PEER, 7)],
            [credit(VICTIM, 10)],
            [credit(PEER, 7), credit(VICTIM, 10)],
        ]) {
            expect((await verifyAdmissionEdits(award({}, edits))).ok).toBe(false)
        }
    })

    it("is refused when an edit is not a plain points credit", async () => {
        for (const over of [
            { operation: "remove" },
            { context: "web2" },
            { isRollback: true },
            { type: "balance" },
            { referralCode: "x" },
            { amount: -10 },
        ]) {
            const tx = award({}, [credit(VICTIM, 10, over), credit(PEER, 7)])
            expect((await verifyAdmissionEdits(tx)).ok).toBe(false)
        }
    })

    it("is refused with a date that is not one timestamp shared by the whole award", async () => {
        expect((await verifyAdmissionEdits(award({}, [credit(VICTIM, 10), credit(PEER, 7, { date: "2026-10-28T00:00:00.000Z" })]))).ok).toBe(false)
        expect((await verifyAdmissionEdits(award({}, [credit(VICTIM, 10, { date: "yesterday" }), credit(PEER, 7, { date: "yesterday" })]))).ok).toBe(false)
    })

    it("does not make any other identity transaction an award", async () => {
        const tx = award({ data: ["identity", { context: "xm", method: "xm_identity_assign", payload: {} }] })
        expect((await verifyAdmissionEdits(tx)).ok).toBe(false)
    })
})

describe("node-authored transactions that carry no edits", () => {
    const relay = (type: string, edits: unknown[] = []): Transaction =>
        ({
            hash: "ef".repeat(32),
            content: { type, from: SENDER, from_ed25519_address: SENDER, to: SENDER, amount: 0, nonce: 123456, gcr_edits: edits },
        }) as unknown as Transaction

    it("admits an l2psBatch with no edits and refuses one that ships any", async () => {
        expect((await verifyAdmissionEdits(relay("l2psBatch"))).ok).toBe(true)
        expect((await verifyEditsAtApply(relay("l2psBatch"))).ok).toBe(true)
        const forged = relay("l2psBatch", [{ type: "nonce", operation: "add", account: VICTIM, amount: 5, isRollback: false, txhash: "" }])
        expect((await verifyAdmissionEdits(forged)).ok).toBe(false)
        expect((await verifyEditsAtApply(forged)).ok).toBe(false)
    })

    it("admits a signalling-server message with no edits and refuses one that ships a forged edit", async () => {
        expect((await verifyAdmissionEdits(relay("instantMessaging"))).ok).toBe(true)
        const forged = relay("instantMessaging", [{ type: "balance", operation: "add", account: SENDER, amount: "1000000000", isRollback: false, txhash: "" }])
        expect((await verifyAdmissionEdits(forged)).ok).toBe(false)
        expect((await verifyEditsAtApply(forged)).ok).toBe(false)
    })

    it("treats a client-signed message like any other type", async () => {
        const tx = await handMade("instantMessaging", { senderId: "a", targetId: "b", message: "m", timestamp: 1 })
        expect((await verifyAdmissionEdits(onTheWire(tx))).ok).toBe(true)
    })

    it("holds an l2psEncryptedTx, which never enters the pool, to the same rule as any other type", async () => {
        const tx = await handMade("l2psEncryptedTx", { l2ps_uid: "u", encrypted_tx: "x" })
        expect((await verifyAdmissionEdits(onTheWire(tx))).ok).toBe(true)
        const forged = onTheWire(tx)
        edits(forged).push({ type: "balance", operation: "add", account: SENDER, amount: "1", isRollback: false, txhash: "" })
        expect((await verifyAdmissionEdits(forged)).ok).toBe(false)
    })

    it("compares an atomicWork with the Work edits the node derives, like any other type", async () => {
        chainIs(true)
        const tx = onTheWire(
            await DemosTransactions.atomicWork(
                {
                    intent: { profile: "p" },
                    authorizations: [],
                    edits: [{ type: "work-attempt", workId: "w", attemptId: "a", canonicalBytesHash: "h" }],
                    transfers: [{ to: PEER, amount: "25" }],
                } as never,
                demos,
            ),
        )
        expect((await verifyEditsAgainstBody(tx)).ok).toBe(true)
        edits(tx).find(e => e.type === "balance" && e.operation === "add")!.account = VICTIM
        expect((await verifyEditsAgainstBody(tx)).ok).toBe(false)
    })
})
