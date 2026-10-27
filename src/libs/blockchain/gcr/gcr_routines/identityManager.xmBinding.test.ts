import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from "bun:test"
import { cloneDefaultForkConfig, type ForkConfigByName } from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"
import { xmBoundProofMessage } from "@/libs/identity/xmProof"
import {
    aptosFixture,
    evmFixture,
    ibcFixture,
    nearFixture,
    tonFixture,
    xrplFixture,
    type ChainFixture,
} from "@/libs/identity/xmProof.fixtures"

const SENDER = "0x" + "ab".repeat(32)

// The package barrel also loads the Tron module, whose generated protobuf code
// does not initialise under `bun test`. The real chain modules the node uses
// for these checks are loaded one by one instead.
const LOCALSDK = "../../../../../node_modules/@kynesyslabs/demosdk/build/multichain/localsdk/"
mock.module("@kynesyslabs/demosdk/xm-localsdk", () => ({
    XRPL: require(LOCALSDK + "xrp.js").XRPL,
    EVM: require(LOCALSDK + "evm.js").EVM,
    IBC: require(LOCALSDK + "ibc.js").IBC,
    TON: require(LOCALSDK + "ton.js").TON,
    SOLANA: require(LOCALSDK + "solana.js").SOLANA,
    MULTIVERSX: require(LOCALSDK + "multiversx.js").MULTIVERSX,
    NEAR: require(LOCALSDK + "near.js").NEAR,
    BTC: require(LOCALSDK + "btc.js").BTC,
    APTOS: require(LOCALSDK + "aptos.js").APTOS,
}))
const IdentityManager = (await import("./identityManager")).default

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
    })
    afterEach(() => {
        while (restores.length) restores.pop()!()
        getSharedState.forkConfig = forks
        getSharedState.lastBlockNumber = tip
    })

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

        it("refuses a NEAR named account", async () => {
            const f = nearFixture()
            const r = await IdentityManager.verifyPayload(
                await payloadFor(f, SENDER, { targetAddress: "alice.near" }),
                SENDER,
            )
            expect(r.success).toBe(false)
            expect(r.message).toContain("named accounts")
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

    afterEach(() => getIdentities?.mockRestore())

    function linked(xm: any) {
        getIdentities = spyOn(IdentityManager, "getIdentities").mockResolvedValue(xm)
    }

    it("refuses Nomis, Ethos and Human Passport for a wallet the account never linked", async () => {
        linked({})
        const nomis = await IdentityManager.verifyNomisPayload(
            { chain: "evm", subchain: "mainnet", address: evmAddr } as any,
            SENDER,
        )
        const ethos = await IdentityManager.verifyEthosPayload(
            { chain: "evm", subchain: "mainnet", address: evmAddr } as any,
            SENDER,
        )
        const hp = await IdentityManager.verifyHumanPassportPayload(
            { address: evmAddr, verificationMethod: "api" },
            SENDER,
        )
        expect(nomis.success).toBe(false)
        expect(ethos.success).toBe(false)
        expect(hp.success).toBe(false)
        expect(nomis.message).toContain("not linked")
    })

    it("accepts Nomis and Ethos for a wallet linked on any subchain, ignoring address case", async () => {
        linked({ evm: { polygon: [{ address: evmAddr.toLowerCase() }] } })
        const nomis = await IdentityManager.verifyNomisPayload(
            { chain: "evm", subchain: "mainnet", address: evmAddr } as any,
            SENDER,
        )
        const ethos = await IdentityManager.verifyEthosPayload(
            { chain: "evm", subchain: "mainnet", address: evmAddr } as any,
            SENDER,
        )
        expect(nomis.success).toBe(true)
        expect(ethos.success).toBe(true)
    })

    it("does not accept a wallet linked on another chain", async () => {
        linked({ solana: { mainnet: [{ address: evmAddr }] } })
        const nomis = await IdentityManager.verifyNomisPayload(
            { chain: "evm", subchain: "mainnet", address: evmAddr } as any,
            SENDER,
        )
        expect(nomis.success).toBe(false)
    })
})
