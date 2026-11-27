/**
 * The confirm-time L2PS balance check opens the inner transaction with the
 * node's chain id once signatureDomain is active, so a transfer an SDK client
 * signed over `demos-tx:v1:<chainId>:<hash>` gets validity data instead of
 * "signature does not verify". It refuses the legacy bare-hash form and a
 * signature for another chain, as L1 does; before activation nothing changes.
 * Only the L2PS balance check is judged: the outer envelope's fee split is
 * other tests' business.
 * Envelopes come from the real SDK; the chain, the GCR and L2PS balance
 * reads, admission and the validity signature are replaced.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { mockLogger } from "@/utilities/testSupport/coreMocks"

mockLogger("src/utilities/logger")
mock.module("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: { getLastBlockNumber: async () => 100 },
}))
mock.module("src/libs/blockchain/gcr/gcr", () => ({
    __esModule: true,
    default: {
        getAccountNonce: async () => 7,
        getAccountBalance: async () => 1_000_000_000_000_000n,
    },
}))
mock.module("src/libs/blockchain/validation/txAdmission", () => ({
    checkTxAdmissible: async () => ({ ok: true }),
}))
mock.module("src/libs/blockchain/validation/validityData", () => ({
    signValidityData: async (v: unknown) => v,
}))
mock.module("@/libs/l2ps/L2PSTransactionExecutor", () => ({
    __esModule: true,
    L2PS_TX_FEE: 1,
    default: { getBalance: async () => 1_000_000_000_000_000n },
}))

import type { L2PS } from "@kynesyslabs/demosdk/l2ps"
import type { Transaction } from "@kynesyslabs/demosdk/types"
import { getSharedState } from "@/utilities/sharedState"
import { SENDER, chainIs, handMade, onTheWire } from "src/libs/blockchain/validation/editBinding.fixtures"
import { sealed, settledTransfer, signer, subnet } from "@/libs/l2ps/__fixtures__/chainSignedTransfer"

const { confirmTransaction } = await import("./validateTransaction")
const { INNER_TX_NOT_DOMAIN_SIGNED } = await import("@/libs/l2ps/innerTxDecrypt")
const parallelNetworks = (await import("@/libs/l2ps/parallelNetworks")).default

const CHAIN = 4242
const UID = "chain_id_subnet"

const saved = {
    forkConfig: getSharedState.forkConfig,
    lastBlockNumber: getSharedState.lastBlockNumber,
    chainId: getSharedState.chainId,
}
const networks = parallelNetworks.getInstance() as any
const original = { getL2PS: networks.getL2PS, loadL2PS: networks.loadL2PS }

let l2ps: L2PS

/** Post-osDenomination chain at tip 100, signatureDomain from `height` (null: never). */
function chain(height: number | null): void {
    chainIs(true, 0)
    getSharedState.forkConfig.signatureDomain.activationHeight = height
    getSharedState.chainId = CHAIN
}

/** The outer l2psEncryptedTx carrying `inner`, as a client sends it to confirm. */
async function envelopeOf(inner: Transaction): Promise<Transaction> {
    const payload = (await sealed(l2ps, inner)).content.data[1]
    return onTheWire(await handMade("l2psEncryptedTx", payload))
}

const confirm = async (inner: Transaction) => (await confirmTransaction((await envelopeOf(inner)) as never, SENDER)).data

beforeEach(async () => {
    l2ps = await subnet(UID)
    networks.getL2PS = async () => l2ps
    networks.loadL2PS = async () => l2ps
})

afterEach(() => {
    Object.assign(networks, original)
    Object.assign(getSharedState, saved)
})

describe("confirm of an L2PS transfer after signatureDomain activation", () => {
    beforeEach(() => chain(0))

    it("passes the balance check for a transfer signed for this chain", async () => {
        const data = await confirm(await settledTransfer(await signer({ domain: true, chainId: CHAIN }), UID))
        expect(data.message).not.toContain("BALANCE ERROR")
        expect(data.message).not.toContain("does not verify")
    })

    it("refuses a legacy bare-hash signature", async () => {
        const data = await confirm(await settledTransfer(await signer({ domain: false, chainId: CHAIN }), UID))
        expect(data.valid).toBe(false)
        expect(data.message).toContain(INNER_TX_NOT_DOMAIN_SIGNED)
    })

    it("refuses a transfer signed for another chain", async () => {
        const foreign = await signer({ domain: true, chainId: CHAIN + 1 })
        const data = await confirm(await settledTransfer(foreign, UID, { settlementChainId: CHAIN }))
        expect(data.valid).toBe(false)
        expect(data.message).toContain("signature does not verify")
    })
})

describe("confirm of an L2PS transfer before signatureDomain activation", () => {
    beforeEach(() => chain(null))

    it("passes a legacy-signed transfer, as before", async () => {
        const data = await confirm(await settledTransfer(await signer({ domain: false, chainId: CHAIN }), UID))
        expect(data.message).not.toContain("BALANCE ERROR")
        expect(data.message).not.toContain("does not verify")
    })

    it("refuses a domain-signed transfer, as L1 does before activation", async () => {
        const data = await confirm(await settledTransfer(await signer({ domain: true, chainId: CHAIN }), UID))
        expect(data.valid).toBe(false)
        expect(data.message).toContain("signature does not verify")
    })
})
