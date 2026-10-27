import { afterEach, beforeEach, describe, expect, it, jest, mock, spyOn } from "bun:test"
import { dirname, join } from "node:path"
import { Wallet } from "ethers"
import { cloneDefaultForkConfig } from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"
import { evmFixture, type ChainFixture } from "@/libs/identity/testSupport/xmProofFixtures"

// Identity transactions reaching a node by gossip or by the consensus mempool
// merge must pass the same proof checks as the RPC confirm path; block
// application stores the signed values without asking any provider.

const SENDER = "0x" + "ab".repeat(32)
const ETHOS_WALLET = "0x" + "cd".repeat(20)

const logError = jest.fn()
mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
        warning: jest.fn(),
        warn: jest.fn(),
        error: logError,
        only: jest.fn(),
        custom: jest.fn(),
    },
}))

// The package barrel also loads the Tron module, whose generated protobuf code
// does not initialise under `bun test`.
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

mock.module("@/model/datasource", () => ({
    __esModule: true,
    default: { getInstance: jest.fn() },
}))

mock.module("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: {
        getLastBlockNumber: jest.fn(async () => 100),
        getExistingTransactionHashes: jest.fn(async () => new Set<string>()),
    },
}))

mock.module("src/libs/blockchain/validation/txValidatorPool", () => ({
    __esModule: true,
    default: {
        getInstance: () => ({
            validate: jest.fn(async (txs: Array<{ hash: string }>) =>
                txs.map(t => ({ valid: true, hash: t.hash })),
            ),
            verify: jest.fn(async () => true),
        }),
    },
}))

const editsMatch = { match: true }
mock.module("src/libs/blockchain/validation/verifyGcrEdits", () => ({
    verifyGcrEditsMatch: jest.fn(async () => editsMatch),
    verifyNoUnexplainedValueEdits: jest.fn(async () => ({ ok: true, unexplained: [] })),
}))

mock.module("src/libs/blockchain/validation/txAdmission", () => ({
    checkTxAdmissible: jest.fn(async () => ({ ok: true })),
}))

let insertedRows: Array<Record<string, unknown>> = []
mock.module("src/libs/blockchain/chainDb", () => ({
    chunkedInsert: jest.fn(
        async (_repo: unknown, _entity: unknown, rows: Array<Record<string, unknown>>) => {
            insertedRows.push(...rows)
            return { inserted: rows.length }
        },
    ),
}))

mock.module("src/libs/consensus/v2/types/secretaryManager", () => ({
    __esModule: true,
    default: class {
        static lastBlockRef = 100
    },
}))

const Mempool = (await import("./mempool")).default
const IdentityManager = (await import("./gcr/gcr_routines/identityManager")).default
const { EthosApiClient } = await import("@/libs/identity/tools/ethos")
const { Twitter } = await import("@/libs/identity/tools/twitter")

function identityTx(hash: string, method: string, payload: unknown) {
    return {
        hash,
        status: "pending",
        reference_block: 100,
        blockNumber: 100,
        content: {
            type: "identity",
            from: SENDER,
            from_ed25519_address: SENDER,
            gcr_edits: [],
            data: ["identity", { method, payload }],
        },
    } as any
}

const ethosTx = (hash: string, score: number) =>
    identityTx(hash, "ethos_identity_assign", {
        chain: "evm",
        subchain: "mainnet",
        address: ETHOS_WALLET,
        score,
        profileId: 77,
        lastSyncedAt: "2026-10-27T10:00:00.000Z",
    })

async function xmTx(hash: string, signer?: ChainFixture) {
    const f = evmFixture()
    const sign = signer?.sign ?? f.sign
    return identityTx(hash, "xm_identity_assign", {
        target_identity: {
            chain: f.chain,
            subchain: f.subchain,
            chainId: 1,
            isEVM: true,
            targetAddress: f.targetAddress,
            signedData: SENDER,
            signature: await sign(SENDER),
        },
    })
}

const otherEvmSigner = (): ChainFixture => {
    const wallet = new Wallet("0x" + "22".repeat(32))
    return { ...evmFixture(), sign: m => wallet.signMessage(m) }
}

const twitterTx = (hash: string, userId: string) =>
    identityTx(hash, "web2_identity_assign", {
        context: "twitter",
        username: "alice",
        userId,
        proof: "https://x.com/alice/status/1",
    })

const gossip = (tx: any) =>
    Mempool.ingestGossiped({
        data: { transaction: tx, reference_block: tx.reference_block },
    } as any)

describe("identity proofs are checked when a transaction reaches the mempool from a peer", () => {
    const restores: Array<() => void> = []
    let ethosScore: ReturnType<typeof spyOn>
    let added: string[]
    let tweetLookups: number
    let saved: { forkConfig: any; lastBlockNumber: number; referenceBlockRoom: number }

    beforeEach(() => {
        saved = {
            forkConfig: getSharedState.forkConfig,
            lastBlockNumber: getSharedState.lastBlockNumber,
            referenceBlockRoom: getSharedState.referenceBlockRoom,
        }
        getSharedState.forkConfig = cloneDefaultForkConfig()
        getSharedState.lastBlockNumber = 100
        getSharedState.referenceBlockRoom = 1

        insertedRows = []
        added = []
        tweetLookups = 0
        editsMatch.match = true
        logError.mockClear()
        ;(Mempool as any).repo = { find: jest.fn(async () => []) }

        const add = spyOn(Mempool, "addTransactionWithLock").mockImplementation(
            async (tx: any) => {
                added.push(tx.hash)
                return { confirmationBlock: 101, error: "" } as any
            },
        )
        const filter = spyOn(IdentityManager, "filterConnections").mockResolvedValue({
            success: true,
            message: "ok",
            twitterAccountConnected: true,
        } as any)
        // The Ethos wallet is linked; the xm wallet is not yet.
        const ids = spyOn(IdentityManager, "getIdentities").mockResolvedValue({
            evm: { mainnet: [{ address: ETHOS_WALLET }] },
        } as any)
        ethosScore = spyOn(EthosApiClient.getInstance(), "getScore").mockResolvedValue({
            score: 1450,
            profileId: 77,
        } as any)
        const twitter = spyOn(Twitter, "getInstance").mockReturnValue({
            extractTweetDetails: () => ({ username: "alice", tweetId: "1" }),
            getTweetById: async () => {
                tweetLookups++
                return undefined
            },
            checkIsBot: async () => {
                tweetLookups++
                return false
            },
        } as any)
        restores.push(
            () => add.mockRestore(),
            () => filter.mockRestore(),
            () => ids.mockRestore(),
            () => ethosScore.mockRestore(),
            () => twitter.mockRestore(),
        )
    })

    afterEach(() => {
        while (restores.length) restores.pop()!()
        getSharedState.forkConfig = saved.forkConfig
        getSharedState.lastBlockNumber = saved.lastBlockNumber
        getSharedState.referenceBlockRoom = saved.referenceBlockRoom
    })

    describe("gossip ingest", () => {
        it("refuses an Ethos score the provider does not report", async () => {
            const r = await gossip(ethosTx("0xinflated", 9999))
            expect(r.accepted).toBe(false)
            expect(r.reason).toContain("does not match the score Ethos reports")
            expect(added).toEqual([])
        })

        it("refuses an xm proof whose signature does not verify", async () => {
            const r = await gossip(await xmTx("0xforgedxm", otherEvmSigner()))
            expect(r.accepted).toBe(false)
            expect(r.reason).toContain("signature could not be verified")
            expect(added).toEqual([])
        })

        it("refuses a web2 claim with a padded user id before calling the provider", async () => {
            const r = await gossip(twitterTx("0xpadded", " 42 "))
            expect(r.accepted).toBe(false)
            expect(r.reason).toContain("whole number")
            expect(tweetLookups).toBe(0)
        })

        it("refuses when the provider cannot be reached", async () => {
            ethosScore.mockImplementation(async () => {
                throw new Error("ECONNREFUSED")
            })
            const r = await gossip(ethosTx("0xoffline", 1450))
            expect(r.accepted).toBe(false)
            expect(r.reason).toContain("try again later")
            expect(added).toEqual([])
        })

        it("refuses identity edits that differ from the ones the payload implies, without a provider call", async () => {
            editsMatch.match = false
            const r = await gossip(ethosTx("0xswapped", 1450))
            expect(r.accepted).toBe(false)
            expect(r.reason).toContain("gcr_edits do not match")
            expect(ethosScore).not.toHaveBeenCalled()
        })

        it("admits valid Ethos and xm identity transactions", async () => {
            const ethos = await gossip(ethosTx("0xethosok", 1450))
            const xm = await gossip(await xmTx("0xxmok"))
            expect(ethos).toEqual({ accepted: true, confirmationBlock: 101 })
            expect(xm).toEqual({ accepted: true, confirmationBlock: 101 })
            expect(added).toEqual(["0xethosok", "0xxmok"])
        })
    })

    describe("consensus mempool merge", () => {
        it("keeps only the identity transactions whose proofs verify", async () => {
            await Mempool.receive([
                ethosTx("0xinflated", 9999),
                await xmTx("0xforgedxm", otherEvmSigner()),
                twitterTx("0xpadded", "042"),
                ethosTx("0xethosok", 1450),
                await xmTx("0xxmok"),
            ])
            expect(insertedRows.map(r => r.hash).sort()).toEqual(["0xethosok", "0xxmok"])
            const refused = logError.mock.calls
                .map(c => String(c[0]))
                .filter(m => m.startsWith("[Mempool.receive] Rejecting tx"))
            expect(refused.some(m => m.includes("0xinflated"))).toBe(true)
            expect(refused.some(m => m.includes("0xforgedxm"))).toBe(true)
            expect(refused.some(m => m.includes("0xpadded"))).toBe(true)
        })

        it("refuses every identity transaction while the provider is unreachable", async () => {
            ethosScore.mockImplementation(async () => {
                throw new Error("timeout")
            })
            await Mempool.receive([ethosTx("0xethos", 1450)])
            expect(insertedRows).toEqual([])
        })

        it("refuses identity edits that differ from the ones the payload implies", async () => {
            editsMatch.match = false
            await Mempool.receive([ethosTx("0xswapped", 1450)])
            expect(insertedRows).toEqual([])
            expect(ethosScore).not.toHaveBeenCalled()
        })
    })
})

describe("checkIdentityAdmission", () => {
    it("lets other transaction types through untouched", async () => {
        const { checkIdentityAdmission } = await import("./validation/identityAdmission")
        expect(
            await checkIdentityAdmission({ content: { type: "native" } } as any),
        ).toEqual({ ok: true })
    })

    it("refuses a transaction whose proof check outlives the deadline", async () => {
        const { checkIdentityAdmission } = await import("./validation/identityAdmission")
        const ethos = spyOn(EthosApiClient.getInstance(), "getScore").mockImplementation(
            () => new Promise(() => {}),
        )
        const ids = spyOn(IdentityManager, "getIdentities").mockResolvedValue({
            evm: { mainnet: [{ address: ETHOS_WALLET }] },
        } as any)
        try {
            const r = await checkIdentityAdmission(ethosTx("0xslow", 1450), 50)
            expect(r).toEqual({
                ok: false,
                reason: "identity proof could not be verified in time",
            })
        } finally {
            ethos.mockRestore()
            ids.mockRestore()
        }
    })
})
