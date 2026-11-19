/**
 * Under `keylessWeb2Identity` GitHub, Discord and Twitter accounts link only
 * through TLSNotary: `web2_identity_assign` for them is refused at admission
 * and at apply, before any provider is asked, so a validator without the
 * provider credentials decides it like every other. Telegram web2 links,
 * every remove and the links already stored are unchanged, and a TLSN
 * Twitter link earns what a web2 one did. Requests come from the SDK
 * builders through the edit generator.
 */
import { afterEach, beforeEach, describe, expect, it, jest, mock, spyOn } from "bun:test"
import { Identities } from "@kynesyslabs/demosdk/abstraction"

mock.module("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: { getLastBlockNumber: async () => 100 },
}))
mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: { debug: () => {}, info: () => {}, warn: () => {}, warning: () => {}, error: () => {}, only: () => {} },
}))

// The provider fetch is what the fork takes out of the path; recording the
// calls shows whether a request still reaches it.
const abstraction = await import("@/libs/abstraction")
const verifyWeb2Proof = jest.fn(async () => ({ success: true, message: "verified" }))
mock.module("@/libs/abstraction", () => ({ ...abstraction, verifyWeb2Proof }))

// A real presentation cannot be built here; the context rule is under test.
const tlsnotary = await import("@/libs/tlsnotary")
mock.module("@/libs/tlsnotary", () => ({
    ...tlsnotary,
    verifyTLSNProof: async () => ({ success: true, message: "verified" }),
}))

const { DEFAULT_FORK_CONFIG, cloneDefaultForkConfig } = await import("@/forks/forkConfig")
const { loadForkConfigFromGenesis } = await import("@/forks/loadForkConfig")
const { keylessWeb2IdentityActive, tlsnLinkContexts } = await import("@/forks/keylessWeb2IdentityGate")
const { getSharedState } = await import("@/utilities/sharedState")
const { dataSource } = await import("@/model/datasource")
const { demos, viaConfirm } = await import("@/libs/blockchain/validation/editBinding.fixtures")
const { generateGcrEdits } = await import("@/libs/blockchain/validation/generateGcrEdits")
const { checkIdentityAdmission } = await import("@/libs/blockchain/validation/identityAdmission")
const { default: identityManager } = await import("@/libs/blockchain/gcr/gcr_routines/identityManager")
const { IncentiveManager: incentives } = await import("@/libs/blockchain/gcr/gcr_routines/IncentiveManager")
const { applyTLSNIdentityAdd, applyTLSNIdentityRemove } = await import(
    "@/libs/blockchain/gcr/gcr_routines/routines/tlsnRoutines"
)
const { applyWeb2IdentityAdd, applyWeb2IdentityRemove } = await import(
    "@/libs/blockchain/gcr/gcr_routines/routines/web2Routines"
)
const { default: handleIdentityRequest } = await import(
    "@/libs/network/routines/transactions/handleIdentityRequest"
)
const { MAINNET_FORKS } = await import("../../scripts/launch-go-no-go")
const template = (await import("../../docs/mainnet/genesis.template.json")).default
const devnet = (await import("../../testing/devnet/genesis.devnet.json")).default

const identities = new Identities()
const SENDER: string = demos.getAddress()
const KEYED = ["github", "discord", "twitter"] as const
const PROOFS: Record<string, string> = {
    github: "https://gist.github.com/alice/abc123",
    discord: "https://discord.com/channels/1/2/3",
    twitter: "https://x.com/alice/status/1",
}
const refusal = (context: string) =>
    `${context} accounts link through TLSNotary (tlsn_identity_assign) on this network; ` +
    "the web2 proof path is closed for them"

let saved: { forkConfig: any; lastBlockNumber: number }
let linked: ReturnType<typeof spyOn>
beforeEach(() => {
    saved = { forkConfig: getSharedState.forkConfig, lastBlockNumber: getSharedState.lastBlockNumber }
    getSharedState.forkConfig = cloneDefaultForkConfig()
    getSharedState.lastBlockNumber = 500
    verifyWeb2Proof.mockClear()
    linked = spyOn(identityManager, "isWeb2AccountLinked").mockResolvedValue(false)
})
afterEach(() => {
    linked.mockRestore()
    getSharedState.forkConfig = saved.forkConfig
    getSharedState.lastBlockNumber = saved.lastBlockNumber
})
/** Schedules the fork at `height`; the tip stays at 500. */
const forkAt = (height: number | null) => {
    getSharedState.forkConfig.keylessWeb2Identity.activationHeight = height
}

async function identityEdit(tx: any): Promise<any> {
    const edit = (await generateGcrEdits(tx)).find(e => e.type === "identity")
    if (!edit) throw new Error("no identity edit")
    return JSON.parse(JSON.stringify(edit))
}

const web2Assign = (context: string) =>
    viaConfirm(() =>
        identities.inferWeb2Identity(demos, {
            context,
            proof: PROOFS[context],
            username: "alice",
            userId: "7",
        } as never),
    )
const telegramAssign = () =>
    viaConfirm(() =>
        identities.inferWeb2Identity(demos, {
            context: "telegram",
            proof: {
                payload: { telegram_user_id: "7", username: "alice", public_key: SENDER, timestamp: 1 },
                signature: "0x01",
            },
            username: "alice",
            userId: "7",
        } as never),
    )
const web2Remove = (context: string) =>
    viaConfirm(() => identities.removeWeb2Identity(demos, { context, username: "alice" } as never))
const PRESENTATION = { version: "0.1.0", data: "00" }
const tlsnAssign = (context: string) =>
    viaConfirm(() =>
        identities.addWeb2IdentityViaTLSN(
            demos,
            context as never,
            PRESENTATION as never,
            "ab".repeat(32),
            { recv: [] } as never,
            [1, 2, 3],
            "alice",
            "7",
            undefined,
            { legacy: true },
        ),
    )
const tlsnRemove = (context: string) =>
    viaConfirm(() => identities.removeWeb2IdentityViaTLSN(demos, context as never, "alice"))

const gistLink = { username: "alice", userId: "7", proof: "p", proofHash: "h", timestamp: 1 }
const tlsnLink = { ...gistLink, proof: PRESENTATION, proofType: "tlsn" }
const account = (web2: Record<string, unknown[]> = {}): any => ({
    pubkey: SENDER,
    identities: { web2: JSON.parse(JSON.stringify(web2)) },
})

describe("keylessWeb2Identity config", () => {
    it("ships dormant, copied per clone, and is scheduled at 0 by the mainnet template and the devnet", () => {
        expect(DEFAULT_FORK_CONFIG.keylessWeb2Identity.activationHeight).toBeNull()
        const a = cloneDefaultForkConfig()
        a.keylessWeb2Identity.activationHeight = 5
        expect(cloneDefaultForkConfig().keylessWeb2Identity.activationHeight).toBeNull()
        expect((template.forks as any).keylessWeb2Identity).toEqual({ activationHeight: 0 })
        expect((devnet.forks as any).keylessWeb2Identity).toEqual({ activationHeight: 0 })
        expect(MAINNET_FORKS).toContain("keylessWeb2Identity")
    })

    it("loads null from a genesis that does not declare it, and a declared height as given", () => {
        loadForkConfigFromGenesis({ forks: {} })
        expect(getSharedState.forkConfig.keylessWeb2Identity.activationHeight).toBeNull()
        loadForkConfigFromGenesis({ forks: { keylessWeb2Identity: { activationHeight: 10 } } })
        expect(getSharedState.forkConfig.keylessWeb2Identity.activationHeight).toBe(10)
    })

    it("binds from its height at the tip", () => {
        forkAt(501)
        expect(keylessWeb2IdentityActive()).toBe(false)
        expect([...tlsnLinkContexts()].sort()).toEqual(["discord", "github", "telegram"])
        forkAt(500)
        expect(keylessWeb2IdentityActive()).toBe(true)
        expect([...tlsnLinkContexts()].sort()).toEqual(["discord", "github", "telegram", "twitter"])
    })
})

describe("admission of web2_identity_assign", () => {
    for (const context of KEYED) {
        it(`refuses ${context} once active, without asking the provider`, async () => {
            forkAt(0)
            const tx = await web2Assign(context)
            expect(await handleIdentityRequest(tx, SENDER)).toEqual({ success: false, message: refusal(context) })
            expect(await checkIdentityAdmission(tx)).toEqual({ ok: false, reason: refusal(context) })
            expect(await checkIdentityAdmission(tx, undefined, "merge")).toEqual({ ok: false, reason: refusal(context) })
            expect(verifyWeb2Proof).not.toHaveBeenCalled()
        })

        it(`verifies ${context} with the provider before the fork`, async () => {
            forkAt(501)
            expect((await handleIdentityRequest(await web2Assign(context), SENDER)).success).toBe(true)
            expect(verifyWeb2Proof).toHaveBeenCalledTimes(1)
        })
    }

    it("still verifies a Telegram attestation once active", async () => {
        forkAt(0)
        expect((await handleIdentityRequest(await telegramAssign(), SENDER)).success).toBe(true)
        expect(verifyWeb2Proof).toHaveBeenCalledTimes(1)
    })

    it("admits every remove once active, and a twitter TLSN remove only then", async () => {
        forkAt(null)
        expect(await handleIdentityRequest(await tlsnRemove("twitter"), SENDER)).toEqual({
            success: false,
            message: "Unsupported TLSN context: twitter",
        })
        forkAt(0)
        for (const context of [...KEYED, "telegram"]) {
            expect((await handleIdentityRequest(await web2Remove(context), SENDER)).success).toBe(true)
        }
        for (const context of KEYED) {
            expect((await handleIdentityRequest(await tlsnRemove(context), SENDER)).success).toBe(true)
        }
    })
})

describe("apply of a web2 link", () => {
    for (const context of KEYED) {
        it(`refuses ${context} once active and leaves the account as it was`, async () => {
            forkAt(500)
            const gcr = account()
            const before = JSON.stringify(gcr)
            expect(await applyWeb2IdentityAdd(await identityEdit(await web2Assign(context)), gcr)).toEqual({
                success: false,
                message: refusal(context),
            })
            expect(JSON.stringify(gcr)).toBe(before)
        })

        it(`stores ${context} before the fork`, async () => {
            forkAt(501)
            const gcr = account()
            const r = await applyWeb2IdentityAdd(await identityEdit(await web2Assign(context)), gcr)
            expect(r.success).toBe(true)
            expect(gcr.identities.web2[context].map((l: any) => l.userId)).toEqual(["7"])
        })

        it(`unlinks a ${context} link stored before the fork`, async () => {
            forkAt(0)
            const gcr = account({ [context]: [gistLink] })
            const r = await applyWeb2IdentityRemove(await identityEdit(await web2Remove(context)), gcr)
            expect(r.success).toBe(true)
            expect(gcr.identities.web2[context]).toEqual([])
        })
    }

    it("stores a Telegram link once active", async () => {
        forkAt(0)
        const gcr = account()
        const r = await applyWeb2IdentityAdd(await identityEdit(await telegramAssign()), gcr)
        expect(r.success).toBe(true)
        expect(gcr.identities.web2.telegram.map((l: any) => l.userId)).toEqual(["7"])
    })
})

describe("apply of a twitter TLSN link", () => {
    it("is refused before the fork, as a context the TLSN path does not know", async () => {
        forkAt(501)
        const gcr = account()
        expect(await applyTLSNIdentityAdd(await identityEdit(await tlsnAssign("twitter")), gcr)).toEqual({
            success: false,
            message: "Unsupported TLSN context: twitter",
        })
        const remove = await applyTLSNIdentityRemove(
            await identityEdit(await tlsnRemove("twitter")),
            account({ twitter: [tlsnLink] }),
        )
        expect(remove).toEqual({ success: false, message: "Unsupported TLSN context: twitter" })
    })

    it("links and unlinks once active, stored where a web2 twitter link is", async () => {
        forkAt(500)
        const gcr = account()
        const add = await applyTLSNIdentityAdd(await identityEdit(await tlsnAssign("twitter")), gcr)
        expect(add.success).toBe(true)
        expect(gcr.identities.web2.twitter.map((l: any) => [l.username, l.userId, l.proofType])).toEqual([
            ["alice", "7", "tlsn"],
        ])
        const remove = await applyTLSNIdentityRemove(await identityEdit(await tlsnRemove("twitter")), gcr)
        expect(remove.success).toBe(true)
        expect(gcr.identities.web2.twitter).toEqual([])
    })
})

describe("the verified TLSN path", () => {
    // The context is judged before the presentation, so a missing one shows
    // which table the link was judged by.
    const judge = () =>
        tlsnotary.verifyTlsnIdentity({ context: "twitter", proof: null, username: "alice", userId: "7", sender: SENDER })

    it("knows twitter only once active", async () => {
        forkAt(501)
        expect(await judge()).toEqual({
            success: false,
            message: "TLSN context twitter cannot be linked with a TLSNotary proof",
        })
        forkAt(500)
        expect(await judge()).toEqual({
            success: false,
            message: "Invalid proof: expected TLSNotary presentation object",
        })
    })
})

describe("points of a twitter link", () => {
    let restoreRepo: () => void
    beforeEach(() => {
        // No other account holds the platform account: a first connection.
        const builder: any = { where: () => builder, andWhere: () => builder, getOne: async () => null }
        const spy = spyOn(dataSource, "getRepository").mockReturnValue({
            createQueryBuilder: () => builder,
        } as never)
        restoreRepo = () => spy.mockRestore()
    })
    afterEach(() => restoreRepo())

    async function calls(run: () => Promise<void>) {
        const award = spyOn(incentives, "twitterLinked").mockResolvedValue({} as never)
        const deduct = spyOn(incentives, "twitterUnlinked").mockResolvedValue({} as never)
        try {
            await run()
            return { award: award.mock.calls, deduct: deduct.mock.calls }
        } finally {
            award.mockRestore()
            deduct.mockRestore()
        }
    }

    it("awards and deducts the same through TLSN as through the web2 path", async () => {
        forkAt(501)
        const web2 = await calls(async () => {
            const gcr = account()
            const add = await applyWeb2IdentityAdd(await identityEdit(await web2Assign("twitter")), gcr)
            await add.sideEffect!()
            const remove = await applyWeb2IdentityRemove(await identityEdit(await web2Remove("twitter")), gcr)
            await remove.sideEffect!()
        })

        forkAt(0)
        const tlsn = await calls(async () => {
            const gcr = account()
            const add = await applyTLSNIdentityAdd(await identityEdit(await tlsnAssign("twitter")), gcr)
            await add.sideEffect!()
            const remove = await applyTLSNIdentityRemove(await identityEdit(await tlsnRemove("twitter")), gcr)
            await remove.sideEffect!()
        })

        expect(web2.award).toEqual([[SENDER, "7", undefined]])
        expect(web2.deduct).toEqual([[SENDER]])
        expect(tlsn).toEqual(web2)
    })
})
