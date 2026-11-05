/**
 * identityCarryover at apply time: web2 unlink by platform account and no
 * first-link award for identities the genesis imported. The edits come from
 * real SDK-built, signed transactions; before the fork both routines must
 * behave exactly as they did.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"

mock.module("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: { getLastBlockNumber: async () => 100 },
}))
mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: { debug: () => {}, info: () => {}, warning: () => {}, error: () => {}, only: () => {} },
}))

import { Identities } from "@kynesyslabs/demosdk/abstraction"
import type { Transaction } from "@kynesyslabs/demosdk/types"
import { cloneDefaultForkConfig } from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"
import { dataSource } from "@/model/datasource"
import { GenesisImportedIdentity } from "@/model/entities/GenesisImportedIdentity"
import { chainIs, demos, handMade, viaConfirm } from "@/libs/blockchain/validation/editBinding.fixtures"
import { generateGcrEdits } from "@/libs/blockchain/validation/generateGcrEdits"
import { IncentiveManager } from "../IncentiveManager"
import { applyWeb2IdentityAdd, applyWeb2IdentityRemove } from "./web2Routines"
import { applyTLSNIdentityRemove } from "./tlsnRoutines"
import { isFirstConnection } from "./utils"
import { importedIdentityKeys } from "@/libs/blockchain/genesis/carryover"

const identities = new Identities()

let saved: { forkConfig: any; lastBlockNumber: number }
beforeEach(() => {
    saved = { forkConfig: getSharedState.forkConfig, lastBlockNumber: getSharedState.lastBlockNumber }
    chainIs(true)
    getSharedState.lastBlockNumber = 500
})
afterEach(() => {
    getSharedState.forkConfig = saved.forkConfig
    getSharedState.lastBlockNumber = saved.lastBlockNumber
})
const carryoverAt = (height: number | null) => {
    getSharedState.forkConfig.identityCarryover.activationHeight = height
}

async function identityEdit(tx: Transaction): Promise<any> {
    const edit = (await generateGcrEdits(tx)).find(e => e.type === "identity")
    if (!edit) throw new Error("no identity edit")
    return JSON.parse(JSON.stringify(edit))
}

const removeWeb2 = async (payload: Record<string, unknown>) =>
    identityEdit(await viaConfirm(() => identities.removeWeb2Identity(demos, payload as never)))

// The released SDK builder cannot send a userId yet, so those requests are
// built by hand; the rest go through the builder.
const removeTlsn = async (payload: Record<string, unknown>) =>
    payload.userId === undefined
        ? identityEdit(
              await viaConfirm(() =>
                  identities.removeWeb2IdentityViaTLSN(demos, payload.context as never, payload.username as string),
              ),
          )
        : identityEdit(await handMade("identity", { context: "tlsn", method: "tlsn_identity_remove", payload }))

const account = (context: string, links: Array<Record<string, unknown>>): any => ({
    pubkey: demos.getAddress(),
    identities: { web2: { [context]: links.map(l => ({ ...l })) } },
})

const usernames = (r: any, context: string) =>
    (r.entity.identities.web2[context] as Array<{ username: string }>).map(l => l.username)

describe("web2 unlink", () => {
    // One username on two platform accounts: the client supplies the
    // username, so nothing stops an account from storing it twice.
    const sharedHandle = [
        { username: "alice", userId: "7", proof: "p", proofHash: "h", timestamp: 1 },
        { username: "alice", userId: "8", proof: "p", proofHash: "h", timestamp: 1 },
        { username: "carol", userId: "9", proof: "p", proofHash: "h", timestamp: 1 },
    ]
    // One platform account stored under two handles (a rename, or ids
    // compared exactly before web2ProofBinding).
    const renamed = [
        { username: "alice", userId: "7", proof: "p", proofHash: "h", timestamp: 1 },
        { username: "alice-old", userId: 7, proof: "p", proofHash: "h", timestamp: 1 },
    ]

    describe("before identityCarryover", () => {
        for (const [label, height] of [["unscheduled", null], ["scheduled later", 501]] as const) {
            it(`matches by username when the fork is ${label}`, async () => {
                carryoverAt(height)
                const a = await applyWeb2IdentityRemove(await removeWeb2({ context: "github", username: "alice" }), account("github", sharedHandle))
                expect(a.success).toBe(true)
                expect(usernames(a, "github")).toEqual(["carol"])

                const b = await applyWeb2IdentityRemove(await removeWeb2({ context: "github", username: "alice" }), account("github", renamed))
                expect(usernames(b, "github")).toEqual(["alice-old"])

                const c = await applyWeb2IdentityRemove(await removeWeb2({ context: "github", username: "nobody", userId: "7" }), account("github", renamed))
                expect(c).toEqual({ success: false, message: "Identity not found" })
            })
        }
    })

    describe("under identityCarryover", () => {
        beforeEach(() => carryoverAt(0))

        it("refuses a username two platform accounts share, and removes the one the userId names", async () => {
            const a = await applyWeb2IdentityRemove(await removeWeb2({ context: "github", username: "alice" }), account("github", sharedHandle))
            expect(a.success).toBe(false)
            expect(a.message).toContain("name the userId")

            const b = await applyWeb2IdentityRemove(
                await removeWeb2({ context: "github", username: "alice", userId: "8" }),
                account("github", sharedHandle),
            )
            expect(b.success).toBe(true)
            expect((b.entity as any).identities.web2.github.map((l: any) => l.userId)).toEqual(["7", "9"])
        })

        it("removes every link of the platform account, so none is left to unlink and relink again", async () => {
            const r = await applyWeb2IdentityRemove(await removeWeb2({ context: "github", username: "alice" }), account("github", renamed))
            expect(r.success).toBe(true)
            expect(usernames(r, "github")).toEqual([])

            const spy = spyOn(IncentiveManager, "githubUnlinked").mockResolvedValue({} as never)
            try {
                await r.sideEffect!()
                expect(spy).toHaveBeenCalledTimes(1)
                expect(spy.mock.calls[0]).toEqual([demos.getAddress(), "7"])
            } finally {
                spy.mockRestore()
            }
        })

        it("removes the one legacy link stored without a userId by its username", async () => {
            const links = [{ username: "legacy", proof: "p", proofHash: "h", timestamp: 1 }]
            const r = await applyWeb2IdentityRemove(await removeWeb2({ context: "twitter", username: "legacy" }), account("twitter", links))
            expect(r.success).toBe(true)
            expect(usernames(r, "twitter")).toEqual([])
        })

        it("reports an unknown account as not found", async () => {
            const r = await applyWeb2IdentityRemove(await removeWeb2({ context: "github", username: "x", userId: "404" }), account("github", renamed))
            expect(r).toEqual({ success: false, message: "Identity not found" })
        })
    })
})

describe("TLSN unlink", () => {
    const links = [
        { username: "alice", userId: "7", proofType: "tlsn", proof: "p", proofHash: "h", timestamp: 1 },
        { username: "alice-gist", userId: "7", proof: "p", proofHash: "h", timestamp: 1 },
        { username: "bob", userId: "8", proofType: "tlsn", proof: "p", proofHash: "h", timestamp: 1 },
    ]

    it("matches by username before the fork", async () => {
        carryoverAt(null)
        const r = await applyTLSNIdentityRemove(await removeTlsn({ context: "github", username: "alice", userId: "8" }), account("github", links))
        expect(r.success).toBe(true)
        expect(usernames(r, "github")).toEqual(["alice-gist", "bob"])
    })

    it("removes TLSN links by userId under the fork and leaves other proofs alone", async () => {
        carryoverAt(0)
        const r = await applyTLSNIdentityRemove(await removeTlsn({ context: "github", username: "alice", userId: "8" }), account("github", links))
        expect(r.success).toBe(true)
        expect(usernames(r, "github")).toEqual(["alice", "alice-gist"])

        const g = await applyTLSNIdentityRemove(await removeTlsn({ context: "github", username: "alice-gist" }), account("github", links))
        expect(g).toEqual({ success: false, message: "TLSN identity not found" })
    })

    it("takes a userId alone under the fork, as web2 unlink does", async () => {
        carryoverAt(0)
        const r = await applyTLSNIdentityRemove(await removeTlsn({ context: "github", userId: "7" }), account("github", links))
        expect(r.success).toBe(true)
        expect(usernames(r, "github")).toEqual(["alice-gist", "bob"])

        carryoverAt(null)
        const legacy = await applyTLSNIdentityRemove(await removeTlsn({ context: "github", userId: "7" }), account("github", links))
        expect(legacy).toEqual({ success: false, message: "Invalid payload: missing context or username" })
    })
})

describe("unlink with another account's userId", () => {
    // userId 8 is linked on some other account, never on this one.
    const mine = [{ username: "alice", userId: "7", proofType: "tlsn", proof: "p", proofHash: "h", timestamp: 1 }]

    it("changes nothing on this account", async () => {
        carryoverAt(0)
        const web2 = account("github", mine)
        const before = JSON.stringify(web2)
        const a = await applyWeb2IdentityRemove(await removeWeb2({ context: "github", username: "alice", userId: "8" }), web2)
        expect(a).toEqual({ success: false, message: "Identity not found" })
        expect(JSON.stringify(web2)).toBe(before)

        const tlsn = account("github", mine)
        const b = await applyTLSNIdentityRemove(await removeTlsn({ context: "github", userId: "8" }), tlsn)
        expect(b).toEqual({ success: false, message: "TLSN identity not found" })
        expect(JSON.stringify(tlsn)).toBe(before)
    })
})

describe("first-link award for an imported identity", () => {
    let registry: Set<string>
    let registryReads: string[]
    let gcrReads: number
    let restore: () => void

    beforeEach(() => {
        registry = new Set(["web2:github:7"])
        registryReads = []
        gcrReads = 0
        const builder: any = {
            where: () => builder,
            andWhere: () => builder,
            getOne: async () => {
                gcrReads++
                return null
            },
        }
        const spy = spyOn(dataSource, "getRepository").mockImplementation(((target: unknown) =>
            target === GenesisImportedIdentity
                ? {
                      findOneBy: async ({ identityKey }: { identityKey: string }) => {
                          registryReads.push(identityKey)
                          return registry.has(identityKey) ? { identityKey } : null
                      },
                  }
                : { createQueryBuilder: () => builder }) as never)
        restore = () => spy.mockRestore()
    })
    afterEach(() => restore())

    const addGithub = async (userId: unknown) =>
        identityEdit(
            await viaConfirm(() =>
                identities.inferWeb2Identity(demos, {
                    context: "github",
                    proof: "https://gist.github.com/alice/abc123",
                    username: "alice",
                    userId,
                    referralCode: null,
                } as never),
            ),
        )

    async function linkAndAward(userId: unknown): Promise<number> {
        const spy = spyOn(IncentiveManager, "githubLinked").mockResolvedValue({} as never)
        try {
            const r = await applyWeb2IdentityAdd(await addGithub(userId), account("github", []))
            expect(r.success).toBe(true)
            await r.sideEffect!()
            return spy.mock.calls.length
        } finally {
            spy.mockRestore()
        }
    }

    it("pays no award for an imported identity under the fork", async () => {
        carryoverAt(0)
        expect(await linkAndAward("7")).toBe(0)
        expect(registryReads).toEqual(["web2:github:7"])
        expect(gcrReads).toBe(0)
    })

    it("still pays the award for an identity the genesis did not import", async () => {
        carryoverAt(0)
        expect(await linkAndAward("8")).toBe(1)
        expect(registryReads).toEqual(["web2:github:8"])
        expect(gcrReads).toBe(1)
    })

    it("does not read the registry before the fork", async () => {
        carryoverAt(null)
        expect(await linkAndAward("7")).toBe(1)
        expect(registryReads).toEqual([])
    })

    it("keys wallets and domains the way the import does", async () => {
        carryoverAt(0)
        registry = new Set([
            "xm:evm:mainnet:0xabcd",
            "ud:alice.crypto",
            "humanpassport:0xaaaa",
            "nomis:evm:mainnet:0xabcd",
            "ethos:evm:mainnet:0xabcd",
        ])
        expect(await isFirstConnection("web3", { chain: "evm", subchain: "mainnet", address: "0xABCD" })).toBe(false)
        expect(await isFirstConnection("ud", { domain: "Alice.Crypto" })).toBe(false)
        expect(await isFirstConnection("humanpassport", { address: "0xAAAA" })).toBe(false)
        expect(await isFirstConnection("nomis", { chain: "evm", subchain: "mainnet", address: "0xAbCd" })).toBe(false)
        expect(await isFirstConnection("ethos", { chain: "evm", subchain: "mainnet", address: "0xabcd" })).toBe(false)
        expect(gcrReads).toBe(0)
        // Link time lowercases a wallet by the client's isEVM flag, so the
        // same wallet can arrive in either case under any chain label.
        registry = new Set(importedIdentityKeys({ xm: { solana: { mainnet: [{ address: "So1anaAddr" }] } } }))
        expect(await isFirstConnection("web3", { chain: "solana", subchain: "mainnet", address: "so1anaaddr" })).toBe(false)
        expect(await isFirstConnection("web3", { chain: "solana", subchain: "mainnet", address: "So1anaAddr" })).toBe(false)
        expect(await isFirstConnection("web3", { chain: "Solana", subchain: "Mainnet", address: "SO1ANAADDR" })).toBe(false)
        expect(gcrReads).toBe(0)
        // A link without a userId cannot be keyed and falls through to the account scan.
        expect(await isFirstConnection("twitter", {})).toBe(true)
        expect(gcrReads).toBe(1)
    })
})
