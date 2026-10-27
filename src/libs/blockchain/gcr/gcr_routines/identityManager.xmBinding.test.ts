import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from "bun:test"
import { dirname, join } from "node:path"
import { Address } from "@ton/core"
import { AccountAddress } from "@aptos-labs/ts-sdk"
import { cloneDefaultForkConfig, type ForkConfigByName } from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"
import { canonicalWalletAddress, xmBoundProofMessage } from "@/libs/identity/xmProof"
import {
    aptosFixture,
    evmFixture,
    ibcFixture,
    nearFixture,
    tonFixture,
    xrplFixture,
    type ChainFixture,
} from "@/libs/identity/testSupport/xmProofFixtures"

const SENDER = "0x" + "ab".repeat(32)

// The package barrel also loads the Tron module, whose generated protobuf code
// does not initialise under `bun test`. The real chain modules the node uses
// for these checks are loaded one by one instead.
// Resolving the barrel does not load it; its directory holds the modules.
const LOCALSDK = dirname(require.resolve("@kynesyslabs/demosdk/xm-localsdk"))
const localsdk = (file: string) => require(join(LOCALSDK, file))
mock.module("@kynesyslabs/demosdk/xm-localsdk", () => ({
    XRPL: localsdk("xrp.js").XRPL,
    EVM: localsdk("evm.js").EVM,
    IBC: localsdk("ibc.js").IBC,
    TON: localsdk("ton.js").TON,
    SOLANA: localsdk("solana.js").SOLANA,
    MULTIVERSX: localsdk("multiversx.js").MULTIVERSX,
    NEAR: localsdk("near.js").NEAR,
    BTC: localsdk("btc.js").BTC,
    APTOS: localsdk("aptos.js").APTOS,
}))
const IdentityManager = (await import("./identityManager")).default
const { NomisApiClient } = await import("@/libs/identity/tools/nomis")
const { EthosApiClient } = await import("@/libs/identity/tools/ethos")

type Overrides = {
    signedData?: string
    displayAddress?: string
    publicKey?: string
    targetAddress?: string
    signWith?: ChainFixture
}

async function payloadFor(f: ChainFixture, signedData: string, o: Overrides = {}) {
    const signer = o.signWith ?? f
    return {
        method: "identity_assign_from_signature",
        target_identity: {
            chain: f.chain,
            subchain: f.subchain,
            chainId: 1,
            isEVM: f.isEVM,
            targetAddress: o.targetAddress ?? f.targetAddress,
            signedData,
            signature: await signer.sign(signedData),
            publicKey: o.publicKey ?? signer.publicKey,
            displayAddress: o.displayAddress,
        },
    } as any
}

describe("IdentityManager.verifyPayload: xm proof quality", () => {
    let forks: ForkConfigByName
    let tip: number
    const restores: Array<() => void> = []

    beforeEach(() => {
        forks = getSharedState.forkConfig
        tip = getSharedState.lastBlockNumber
        getSharedState.forkConfig = cloneDefaultForkConfig()
        getSharedState.lastBlockNumber = 1000
        // The account lookup in filterConnections needs a database.
        const filter = spyOn(IdentityManager, "filterConnections").mockResolvedValue({
            success: true,
            message: "ok",
            twitterAccountConnected: true,
        })
        restores.push(() => filter.mockRestore())
        linkedXm = {}
        const ids = spyOn(IdentityManager, "getIdentities").mockImplementation(
            async () => linkedXm,
        )
        restores.push(() => ids.mockRestore())
    })
    afterEach(() => {
        while (restores.length) restores.pop()!()
        getSharedState.forkConfig = forks
        getSharedState.lastBlockNumber = tip
    })
    let linkedXm: any = {}

    async function allChains(): Promise<ChainFixture[]> {
        return [
            evmFixture(),
            xrplFixture(),
            tonFixture(),
            await ibcFixture("atom"),
            await ibcFixture("ibc", "osmo"),
            nearFixture(),
            aptosFixture(),
        ]
    }

    describe("before xmProofBinding is scheduled", () => {
        it("still accepts the legacy proof (the sender's address) on every chain", async () => {
            for (const f of await allChains()) {
                const r = await IdentityManager.verifyPayload(
                    await payloadFor(f, SENDER),
                    SENDER,
                )
                expect({ chain: f.chain, success: r.success, message: r.message }).toEqual({
                    chain: f.chain,
                    success: true,
                    message: expect.stringContaining("verified"),
                })
            }
        })
    })

    describe("key-bound chains", () => {
        it("refuses a proof signed by a key that does not own the target address", async () => {
            const victims = [
                xrplFixture(),
                tonFixture(),
                await ibcFixture("atom", "cosmos"),
                await ibcFixture("ibc", "osmo"),
                nearFixture(),
                aptosFixture(),
            ]
            // Another key per chain. Its signature and public key verify
            // against each other, so only the missing tie to the target
            // address can stop the proof.
            const attackers: Record<string, ChainFixture> = {
                xrpl: xrplFixture(),
                ton: tonFixture("mainnet", 77),
                atom: await ibcFixture("atom", "cosmos", 41),
                ibc: await ibcFixture("ibc", "osmo", 42),
                near: nearFixture(66),
                aptos: aptosFixture(65),
            }

            for (const victim of victims) {
                const r = await IdentityManager.verifyPayload(
                    await payloadFor(victim, SENDER, {
                        signWith: attackers[victim.chain],
                    }),
                    SENDER,
                )
                expect({ chain: victim.chain, success: r.success }).toEqual({
                    chain: victim.chain,
                    success: false,
                })
                expect(r.message).toContain("does not belong to the target address")
            }
        })

        it("refuses a key-bound chain proof with no publicKey", async () => {
            const f = xrplFixture()
            const r = await IdentityManager.verifyPayload(
                await payloadFor(f, SENDER, { publicKey: "" }),
                SENDER,
            )
            expect(r.success).toBe(false)
        })

    })

    describe("NEAR named accounts", () => {
        let rpcCalls: Array<{ url: string; body: any }>
        let answer: () => Promise<Response>

        beforeEach(() => {
            rpcCalls = []
            answer = async () => Response.json({ jsonrpc: "2.0", id: "demos", result: { nonce: 1, permission: "FullAccess" } })
            const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (url: any, init: any) => {
                rpcCalls.push({ url: String(url), body: JSON.parse(init.body) })
                return answer()
            }) as any)
            restores.push(() => fetchSpy.mockRestore())
        })

        const named = async (subchain = "mainnet") => {
            const f = { ...nearFixture(), subchain }
            return IdentityManager.verifyPayload(
                await payloadFor(f, SENDER, { targetAddress: "alice.near" }),
                SENDER,
            )
        }

        it("accepts a full-access key of the account, asking the fixed RPC for that network", async () => {
            const f = nearFixture()
            expect((await named()).success).toBe(true)
            expect((await named("testnet")).success).toBe(true)
            expect(rpcCalls.map(c => c.url)).toEqual([
                "https://rpc.mainnet.near.org",
                "https://rpc.testnet.near.org",
            ])
            expect(rpcCalls[0].body.method).toBe("query")
            expect(rpcCalls[0].body.params).toEqual({
                request_type: "view_access_key",
                finality: "final",
                account_id: "alice.near",
                public_key: f.publicKey,
            })
        })

        it("refuses a function-call key", async () => {
            answer = async () =>
                Response.json({
                    result: {
                        nonce: 1,
                        permission: { FunctionCall: { allowance: null, receiver_id: "app.near", method_names: [] } },
                    },
                })
            expect((await named()).success).toBe(false)
        })

        it("refuses a key the account does not have", async () => {
            answer = async () =>
                Response.json({ error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCESS_KEY" } } })
            expect((await named()).success).toBe(false)
            // Older RPC nodes answer an unknown key with result.error.
            answer = async () => Response.json({ result: { error: "access key does not exist" } })
            expect((await named()).success).toBe(false)
        })

        it("refuses when the RPC times out or fails", async () => {
            answer = async () => {
                throw new DOMException("The operation timed out.", "TimeoutError")
            }
            expect((await named()).success).toBe(false)
            answer = async () => new Response("bad gateway", { status: 502 })
            expect((await named()).success).toBe(false)
        })

        it("refuses an unknown network and an invalid account id without asking", async () => {
            expect((await named("betanet")).success).toBe(false)
            const f = nearFixture()
            const r = await IdentityManager.verifyPayload(
                await payloadFor(f, SENDER, { targetAddress: "Alice.near" }),
                SENDER,
            )
            expect(r.success).toBe(false)
            expect(rpcCalls).toEqual([])
        })

        it("keeps implicit accounts offline", async () => {
            expect((await IdentityManager.verifyPayload(await payloadFor(nearFixture(), SENDER), SENDER)).success).toBe(true)
            expect(rpcCalls).toEqual([])
        })
    })

    describe("one spelling per wallet", () => {
        async function spellings(): Promise<Array<{ f: ChainFixture; others: string[] }>> {
            const ton = tonFixture()
            const tonAddr = Address.parse(ton.targetAddress)
            const aptos = aptosFixture()
            const aptosLong = AccountAddress.from(aptos.targetAddress).toStringLong()
            const atom = await ibcFixture("atom")
            const near = nearFixture()
            return [
                {
                    f: ton,
                    others: [
                        tonAddr.toRawString(),
                        tonAddr.toString(),
                        tonAddr.toString({ urlSafe: false, bounceable: false }),
                        tonAddr.toString({ bounceable: false, testOnly: true }),
                    ],
                },
                { f: aptos, others: [aptosLong.slice(2), aptosLong.toUpperCase().replace("0X", "0x")] },
                { f: atom, others: [atom.targetAddress.toUpperCase()] },
                { f: near, others: [near.publicKey as string, near.targetAddress.toUpperCase()] },
            ]
        }

        it("maps every spelling of a wallet to the stored one", async () => {
            for (const { f, others } of await spellings()) {
                for (const other of others) {
                    expect({ other, canonical: canonicalWalletAddress(f.chain, other) }).toEqual({
                        other,
                        canonical: f.targetAddress,
                    })
                }
            }
        })

        it("refuses another spelling than the canonical one, naming it", async () => {
            for (const { f, others } of await spellings()) {
                for (const other of others) {
                    const r = await IdentityManager.verifyPayload(
                        await payloadFor(f, SENDER, { targetAddress: other, displayAddress: other }),
                        SENDER,
                    )
                    expect({ other, ok: r.success }).toEqual({ other, ok: false })
                    expect(r.message).toContain(f.targetAddress)
                }
            }
        })

        it("refuses a second link of the same wallet in any spelling as a duplicate", async () => {
            for (const { f, others } of await spellings()) {
                linkedXm = { [f.chain]: { [f.subchain]: [{ address: f.targetAddress }] } }
                for (const spelling of [f.targetAddress, ...others]) {
                    const r = await IdentityManager.verifyPayload(
                        await payloadFor(f, SENDER, { targetAddress: spelling }),
                        SENDER,
                    )
                    expect({ spelling, ok: r.success }).toEqual({ spelling, ok: false })
                    expect(r.message).toContain("already linked")
                }
            }
        })

        it("treats a wallet stored in an older spelling as the same wallet", async () => {
            const f = tonFixture()
            linkedXm = { ton: { mainnet: [{ address: Address.parse(f.targetAddress).toRawString() }] } }
            const r = await IdentityManager.verifyPayload(await payloadFor(f, SENDER), SENDER)
            expect(r.success).toBe(false)
            expect(r.message).toContain("already linked")
        })

        it("refuses an EVM address that apply would store with mixed case", async () => {
            const f = { ...evmFixture(), isEVM: false }
            const r = await IdentityManager.verifyPayload(await payloadFor(f, SENDER), SENDER)
            expect(r.success).toBe(false)
            expect(r.message).toContain(f.targetAddress.toLowerCase())
        })
    })

    describe("displayAddress", () => {
        it("refuses a displayAddress that differs from the proven address", async () => {
            for (const f of [evmFixture(), xrplFixture(), nearFixture()]) {
                const r = await IdentityManager.verifyPayload(
                    await payloadFor(f, SENDER, {
                        displayAddress: f.chain === "evm" ? "0x" + "12".repeat(20) : "rSomebodyElse",
                    }),
                    SENDER,
                )
                expect({ chain: f.chain, success: r.success }).toEqual({
                    chain: f.chain,
                    success: false,
                })
                expect(r.message).toContain("displayAddress")
            }
        })

        it("accepts the same address in another case on evm, and an absent one", async () => {
            const f = evmFixture()
            const upper = await IdentityManager.verifyPayload(
                await payloadFor(f, SENDER, {
                    displayAddress: f.targetAddress.toLowerCase(),
                }),
                SENDER,
            )
            expect(upper.success).toBe(true)
            const absent = await IdentityManager.verifyPayload(
                await payloadFor(f, SENDER),
                SENDER,
            )
            expect(absent.success).toBe(true)
        })
    })

    describe("once xmProofBinding is active", () => {
        beforeEach(() => {
            // Judged for the next block, so tip 1000 is inside a fork at 1001.
            getSharedState.forkConfig.xmProofBinding.activationHeight = 1001
        })

        it("accepts the canonical, fresh message on every chain", async () => {
            for (const f of await allChains()) {
                const msg = xmBoundProofMessage(f.chain, f.targetAddress, SENDER, Date.now())
                const r = await IdentityManager.verifyPayload(await payloadFor(f, msg), SENDER)
                expect({ chain: f.chain, success: r.success, message: r.message }).toEqual({
                    chain: f.chain,
                    success: true,
                    message: expect.stringContaining("verified"),
                })
            }
        })

        it("refuses a replayed old signature: any other text the wallet once signed", async () => {
            for (const f of await allChains()) {
                const r = await IdentityManager.verifyPayload(
                    await payloadFor(f, "Sign in to example.org\nnonce: 1"),
                    SENDER,
                )
                expect({ chain: f.chain, success: r.success }).toEqual({
                    chain: f.chain,
                    success: false,
                })
            }
        })

        it("refuses the legacy proof (the sender's address)", async () => {
            const f = evmFixture()
            const r = await IdentityManager.verifyPayload(await payloadFor(f, SENDER), SENDER)
            expect(r.success).toBe(false)
        })

        it("refuses a proof signed more than ten minutes ago", async () => {
            const f = evmFixture()
            const msg = xmBoundProofMessage(f.chain, f.targetAddress, SENDER, Date.now() - 11 * 60_000)
            const r = await IdentityManager.verifyPayload(await payloadFor(f, msg), SENDER)
            expect(r.success).toBe(false)
            expect(r.message).toContain("too old")
        })

        it("refuses a proof made for another Demos account", async () => {
            const f = evmFixture()
            const msg = xmBoundProofMessage(f.chain, f.targetAddress, "0x" + "cd".repeat(32), Date.now())
            const r = await IdentityManager.verifyPayload(await payloadFor(f, msg), SENDER)
            expect(r.success).toBe(false)
        })

        it("is judged for the next block: still legacy at tip 999, bound at tip 1000", async () => {
            const f = evmFixture()
            getSharedState.lastBlockNumber = 999
            const legacy = await IdentityManager.verifyPayload(await payloadFor(f, SENDER), SENDER)
            expect(legacy.success).toBe(true)
            getSharedState.lastBlockNumber = 1000
            const bound = await IdentityManager.verifyPayload(await payloadFor(f, SENDER), SENDER)
            expect(bound.success).toBe(false)
        })
    })
})

describe("IdentityManager score identities need a linked wallet", () => {
    const evmAddr = "0x" + "AB".repeat(20)
    let getIdentities: ReturnType<typeof spyOn>
    let nomis: ReturnType<typeof spyOn>
    let ethos: ReturnType<typeof spyOn>

    beforeEach(() => {
        nomis = spyOn(NomisApiClient.getInstance(), "getWalletScore").mockResolvedValue({
            address: evmAddr.toLowerCase(),
            score: 0.4237,
            scoreType: 0,
            mintData: { mintedScore: 40 },
        } as any)
        ethos = spyOn(EthosApiClient.getInstance(), "getScore").mockResolvedValue({
            score: 1450,
            profileId: 77,
            displayName: "Ann",
            username: "ann",
        })
    })
    afterEach(() => {
        getIdentities?.mockRestore()
        nomis.mockRestore()
        ethos.mockRestore()
    })

    function linked(xm: any) {
        getIdentities = spyOn(IdentityManager, "getIdentities").mockResolvedValue(xm)
    }

    const nomisPayload = (o: Record<string, unknown> = {}) =>
        ({
            chain: "evm",
            subchain: "mainnet",
            address: evmAddr,
            score: 0.4237,
            scoreType: 0,
            mintedScore: 40,
            lastSyncedAt: "2026-10-27T10:00:00.000Z",
            ...o,
        }) as any

    const ethosPayload = (o: Record<string, unknown> = {}) =>
        ({
            chain: "evm",
            subchain: "mainnet",
            address: evmAddr,
            score: 1450,
            profileId: 77,
            lastSyncedAt: "2026-10-27T10:00:00.000Z",
            metadata: { displayName: "Ann", username: "ann" },
            ...o,
        }) as any

    it("refuses Nomis, Ethos and Human Passport for a wallet the account never linked", async () => {
        linked({})
        const n = await IdentityManager.verifyNomisPayload(nomisPayload(), SENDER)
        const e = await IdentityManager.verifyEthosPayload(ethosPayload(), SENDER)
        const hp = await IdentityManager.verifyHumanPassportPayload(
            { address: evmAddr, verificationMethod: "api" },
            SENDER,
        )
        expect(n.success).toBe(false)
        expect(e.success).toBe(false)
        expect(hp.success).toBe(false)
        expect(n.message).toContain("not linked")
    })

    it("accepts Nomis and Ethos for a wallet linked on any subchain, ignoring address case", async () => {
        linked({ evm: { polygon: [{ address: evmAddr.toLowerCase() }] } })
        const n = await IdentityManager.verifyNomisPayload(nomisPayload(), SENDER)
        const e = await IdentityManager.verifyEthosPayload(ethosPayload(), SENDER)
        expect(n).toEqual({ success: true, message: "Nomis identity payload verified" })
        expect(e).toEqual({ success: true, message: "Ethos identity payload verified" })
        expect(nomis.mock.calls[0]).toEqual([evmAddr.toLowerCase(), { chain: "evm" }])
        expect(ethos.mock.calls[0]).toEqual([evmAddr.toLowerCase()])
    })

    it("does not accept a wallet linked on another chain", async () => {
        linked({ solana: { mainnet: [{ address: evmAddr }] } })
        const n = await IdentityManager.verifyNomisPayload(nomisPayload(), SENDER)
        expect(n.success).toBe(false)
    })

    describe("signed score against the provider", () => {
        beforeEach(() => linked({ evm: { mainnet: [{ address: evmAddr }] } }))

        it("refuses a Nomis score, model or minted score the provider does not report", async () => {
            for (const o of [
                { score: 0.9 },
                { score: 0.4238 },
                { scoreType: 1 },
                { mintedScore: 41 },
                { mintedScore: null },
            ]) {
                const r = await IdentityManager.verifyNomisPayload(nomisPayload(o), SENDER)
                expect({ o, ok: r.success }).toEqual({ o, ok: false })
            }
        })

        it("tolerates only float formatting noise on the fractional Nomis score", async () => {
            const near = await IdentityManager.verifyNomisPayload(
                nomisPayload({ score: 0.4237 + 1e-12 }),
                SENDER,
            )
            const off = await IdentityManager.verifyNomisPayload(
                nomisPayload({ score: 0.4237 + 1e-6 }),
                SENDER,
            )
            expect(near.success).toBe(true)
            expect(off.success).toBe(false)
        })

        it("requires an exact Ethos score, profile id and the names when sent", async () => {
            for (const o of [
                { score: 1451 },
                { score: 1450.0000001 },
                { profileId: 78 },
                { profileId: undefined },
                { metadata: { displayName: "Bob", username: "ann" } },
                { metadata: { displayName: "Ann" } },
            ]) {
                const r = await IdentityManager.verifyEthosPayload(ethosPayload(o), SENDER)
                expect({ o, ok: r.success }).toEqual({ o, ok: false })
            }
            const noMetadata = await IdentityManager.verifyEthosPayload(
                ethosPayload({ metadata: undefined }),
                SENDER,
            )
            expect(noMetadata.success).toBe(true)
        })

        it("refuses a payload without the score fields apply will store", async () => {
            for (const o of [{ score: undefined }, { score: 0 }, { scoreType: "0" }, { lastSyncedAt: "soon" }]) {
                const r = await IdentityManager.verifyNomisPayload(nomisPayload(o), SENDER)
                expect({ o, ok: r.success }).toEqual({ o, ok: false })
            }
            for (const o of [{ score: undefined }, { score: -1 }, { lastSyncedAt: undefined }]) {
                const r = await IdentityManager.verifyEthosPayload(ethosPayload(o), SENDER)
                expect({ o, ok: r.success }).toEqual({ o, ok: false })
            }
        })

        it("fails closed when the provider cannot be reached", async () => {
            nomis.mockImplementation(async () => {
                throw new Error("timeout")
            })
            ethos.mockImplementation(async () => {
                throw new Error("timeout")
            })
            const n = await IdentityManager.verifyNomisPayload(nomisPayload(), SENDER)
            const e = await IdentityManager.verifyEthosPayload(ethosPayload(), SENDER)
            expect(n.success).toBe(false)
            expect(e.success).toBe(false)
            expect(n.message).toContain("try again later")
        })
    })
})
