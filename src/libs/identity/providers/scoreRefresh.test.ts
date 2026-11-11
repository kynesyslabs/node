/**
 * A wallet already linked to Nomis or Ethos refreshes its score by signing
 * a new assign with the score the node fetched for it. Admission compares
 * that score with the provider's live value, so the fetch must return the
 * live score, not the one stored at the last link.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import { dirname, join } from "node:path"

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

const SENDER = "0x" + "5e".repeat(32)
const WALLET = "0x" + "ab".repeat(20)
const stored = { address: WALLET, score: 0.1, scoreType: 0, profileId: 77, lastSyncedAt: "2026-10-01T00:00:00.000Z" }
const account = {
    pubkey: SENDER,
    identities: {
        xm: { evm: { mainnet: [{ address: WALLET }] } },
        nomis: { evm: { mainnet: [{ ...stored, mintedScore: null, metadata: {} }] } },
        ethos: { evm: { mainnet: [{ ...stored, metadata: {} }] } },
    },
}
const repository = { findOne: async () => structuredClone(account) }
const datasource = {
    __esModule: true,
    default: { getInstance: async () => ({ getDataSource: () => ({ getRepository: () => repository }) }) },
    dataSource: { getRepository: () => repository },
}
mock.module("src/model/datasource", () => datasource)
mock.module("@/model/datasource", () => datasource)

const { default: manageGCRRoutines } = await import("@/libs/network/manageGCRRoutines")
const IdentityManager = (await import("@/libs/blockchain/gcr/gcr_routines/identityManager")).default
const { NomisApiClient } = await import("@/libs/identity/tools/nomis")
const { EthosApiClient } = await import("@/libs/identity/tools/ethos")

describe("score fetch for a wallet already linked", () => {
    const spies: { mockRestore(): void }[] = []
    beforeEach(() => {
        spies.push(
            spyOn(NomisApiClient.getInstance(), "getWalletScore").mockResolvedValue({
                address: WALLET,
                score: 0.4237,
                scoreType: 0,
                mintData: { mintedScore: 40 },
            } as any),
            spyOn(EthosApiClient.getInstance(), "getScore").mockResolvedValue({
                score: 1450,
                profileId: 77,
                displayName: "Ann",
                username: "ann",
            } as any),
        )
    })
    afterEach(() => spies.splice(0).forEach(s => s.mockRestore()))

    it("returns Nomis's live score, which admission accepts as a refresh", async () => {
        const res = await manageGCRRoutines(SENDER, { method: "getNomisScore", params: [{ walletAddress: WALLET }] })
        expect(res.response.score).toBe(0.4237)
        const admitted = await IdentityManager.verifyNomisPayload(
            { chain: "evm", subchain: "mainnet", ...res.response },
            SENDER,
        )
        expect(admitted.success).toBe(true)
    })

    it("returns Ethos's live score, which admission accepts as a refresh", async () => {
        const res = await manageGCRRoutines(SENDER, { method: "getEthosScore", params: [{ walletAddress: WALLET }] })
        expect(res.response.score).toBe(1450)
        const admitted = await IdentityManager.verifyEthosPayload(
            { chain: "evm", subchain: "mainnet", ...res.response },
            SENDER,
        )
        expect(admitted.success).toBe(true)
    })
})
