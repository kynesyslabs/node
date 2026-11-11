/**
 * An account row stored by a read or by admission exists only on the node
 * that served the request. GCRMain is outside the block hash, so nothing
 * notices; but a referral code resolves only against stored rows, so the
 * same block awards referral points on one node and not on another. Rows
 * may only be stored by block apply.
 */

import { beforeEach, describe, expect, it, jest, mock } from "bun:test"
import { dirname, join } from "node:path"

const save = jest.fn(async (row: unknown) => row)
const repository = {
    findOne: async () => null,
    findOneBy: async () => null,
    save,
}
const datasource = () => ({
    __esModule: true,
    dataSource: { getRepository: () => repository },
    default: { getInstance: async () => ({ getDataSource: () => ({ getRepository: () => repository }) }) },
})
mock.module("src/model/datasource", datasource)
mock.module("@/model/datasource", datasource)
mock.module("@/utilities/logger", () => ({
    __esModule: true,
    default: { debug: () => {}, info: () => {}, warn: () => {}, warning: () => {}, error: () => {}, only: () => {} },
}))

// The package barrel loads the Tron module, which does not initialise under
// bun test; the chain modules are loaded one by one instead.
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
const { UDIdentityManager } = await import("./udIdentityManager")
const { NomisIdentityProvider } = await import("@/libs/identity/providers/nomisIdentityProvider")
const { EthosIdentityProvider } = await import("@/libs/identity/providers/ethosIdentityProvider")

const { applyAwardPoints } = await import("./routines/rewardsRoutines")
const { default: HandleGCR } = await import("@/libs/blockchain/gcr/handleGCR")

const UNKNOWN = "0x" + "5e".repeat(32)

beforeEach(() => save.mockClear())

describe("reads and admission checks of an unknown account store no row", () => {
    const calls: Array<[string, () => Promise<unknown>]> = [
        ["IdentityManager.getIdentities", () => IdentityManager.getIdentities(UNKNOWN)],
        ["IdentityManager.isWeb2AccountLinked (web2 admission)", () => IdentityManager.isWeb2AccountLinked(UNKNOWN, "twitter", "42")],
        ["IdentityManager.filterConnections (xm admission)", () =>
            IdentityManager.filterConnections(UNKNOWN, { target_identity: { chain: "evm", subchain: "mainnet", targetAddress: "0x" + "11".repeat(20) } } as any).catch(() => null)],
        ["UDIdentityManager.getUdIdentities", () => UDIdentityManager.getUdIdentities(UNKNOWN)],
        ["UDIdentityManager.getIdentities", () => UDIdentityManager.getIdentities(UNKNOWN)],
        ["NomisIdentityProvider.listIdentities (gcr_routine)", () => NomisIdentityProvider.listIdentities(UNKNOWN)],
        ["EthosIdentityProvider.listIdentities (gcr_routine)", () => EthosIdentityProvider.listIdentities(UNKNOWN)],
        ["NomisIdentityProvider.getWalletScore (gcr_routine)", () =>
            NomisIdentityProvider.getWalletScore(UNKNOWN, "0x" + "11".repeat(20)).catch(() => null)],
        ["EthosIdentityProvider.getWalletScore (gcr_routine)", () =>
            EthosIdentityProvider.getWalletScore(UNKNOWN, "0x" + "11".repeat(20)).catch(() => null)],
    ]
    for (const [name, call] of calls) {
        it(name, async () => {
            await call()
            expect(save).not.toHaveBeenCalled()
        })
    }
})

describe("a sudo points award in a block", () => {
    it("lands on the account the block commits, and stores no row of its own", async () => {
        const account = await HandleGCR.createAccount(UNKNOWN, {}, true)
        const edit = { type: "identity", context: "points", operation: "add", account: UNKNOWN, amount: 25, date: "2026-11-15T00:00:00.000Z" }

        const result = await applyAwardPoints(edit, account)

        expect(result.success).toBe(true)
        expect(account.points.totalPoints).toBe(25)
        expect(account.points.breakdown.weeklyChallenge).toEqual([{ date: edit.date, points: 25 }])
        expect(save).not.toHaveBeenCalled()
    })
})
