/**
 * The settlement aggregator opens each queued row before it plans a batch. A
 * row synced from a peer was never admitted on this node, so this is where
 * its inner signature is first judged, by the rule L1 admission applies:
 * after signatureDomain activation a transfer an SDK client signed for this
 * chain opens, while the legacy bare-hash form and another chain's signature
 * do not. Before activation nothing changes. Rows hold real SDK envelopes.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { mockLogger } from "@/libs/blockchain/testSupport/mockMempoolDeps"

// The stores, the prover and the L1 mempool are never reached by `open`;
// they are replaced so loading the aggregator touches no database.
mock.module("@/libs/blockchain/l2ps_mempool", () => ({
    __esModule: true,
    default: {},
    L2PS_STATUS: {
        PENDING: "pending",
        PROCESSED: "processed",
        EXECUTED: "executed",
        FAILED: "failed",
        BATCHED: "batched",
        CONFIRMED: "confirmed",
    },
}))
mock.module("@/libs/l2ps/zk/L2PSBatchProver", () => ({ L2PSBatchProver: class {} }))
mock.module("@/libs/blockchain/validation/txValidatorPool", () => ({ __esModule: true, default: {} }))
mock.module("@/libs/blockchain/mempool", () => ({ __esModule: true, default: {} }))
mock.module("@/libs/l2ps/L2PSProofManager", () => ({ __esModule: true, default: {} }))
mock.module("@/libs/l2ps/L2PSTransactionExecutor", () => ({ __esModule: true, L2PS_TX_FEE: 1, default: {} }))
mockLogger()

import type { L2PS } from "@kynesyslabs/demosdk/l2ps"
import { cloneDefaultForkConfig } from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"
import { INNER_TX_NOT_DOMAIN_SIGNED } from "./innerTxDecrypt"
import { sealed, settledTransfer, signer, subnet } from "./__fixtures__/chainSignedTransfer"

const aggregator = (await import("./L2PSBatchAggregator")).L2PSBatchAggregator.getInstance() as any
const networks = (await import("./parallelNetworks")).default.getInstance() as any
const original = { loadL2PS: networks.loadL2PS }

const CHAIN = 4242
const UID = "chain_id_subnet"
const saved = {
    forkConfig: getSharedState.forkConfig,
    lastBlockNumber: getSharedState.lastBlockNumber,
    chainId: getSharedState.chainId,
}

let l2ps: L2PS

/** l2psSettlement on, signatureDomain from `height` (null: never), tip at 100. */
function chain(height: number | null): void {
    getSharedState.forkConfig = cloneDefaultForkConfig()
    getSharedState.forkConfig.l2psSettlement.activationHeight = 0
    getSharedState.forkConfig.signatureDomain.activationHeight = height
    getSharedState.chainId = CHAIN
    getSharedState.lastBlockNumber = 100
}

/** What the settlement loop makes of a queue row holding `inner`. */
async function open(inner: any) {
    const envelope = await sealed(l2ps, inner)
    return await aggregator.settlementLoop().deps.open(UID, { hash: envelope.hash, encrypted_tx: envelope })
}

beforeEach(async () => {
    l2ps = await subnet(UID)
    networks.loadL2PS = async () => l2ps
})

afterEach(() => {
    aggregator.settlement = null
    Object.assign(networks, original)
    Object.assign(getSharedState, saved)
})

describe("settlement aggregator opening a row after signatureDomain activation", () => {
    beforeEach(() => chain(0))

    it("opens a transfer an SDK client signed for this chain", async () => {
        const inner = await settledTransfer(await signer({ domain: true, chainId: CHAIN }), UID)
        const opened = await open(inner)
        expect(opened.reason).toBeUndefined()
        expect(opened.ok).toBe(true)
        expect(opened.transfer.from).toBe(inner.content.from)
    })

    it("does not open a legacy bare-hash signature", async () => {
        const opened = await open(await settledTransfer(await signer({ domain: false, chainId: CHAIN }), UID))
        expect(opened.ok).toBe(false)
        expect(opened.reason).toContain(INNER_TX_NOT_DOMAIN_SIGNED)
    })

    it("does not open a transfer signed for another chain", async () => {
        const foreign = await signer({ domain: true, chainId: CHAIN + 1 })
        const opened = await open(await settledTransfer(foreign, UID, { settlementChainId: CHAIN }))
        expect(opened.ok).toBe(false)
        expect(opened.reason).toContain("signature does not verify")
    })
})

describe("settlement aggregator opening a row before signatureDomain activation", () => {
    beforeEach(() => chain(null))

    it("opens a legacy-signed transfer, as before", async () => {
        const opened = await open(await settledTransfer(await signer({ domain: false, chainId: CHAIN }), UID))
        expect(opened.reason).toBeUndefined()
        expect(opened.ok).toBe(true)
    })

    it("does not open a domain-signed transfer, as L1 refuses it before activation", async () => {
        const opened = await open(await settledTransfer(await signer({ domain: true, chainId: CHAIN }), UID))
        expect(opened.ok).toBe(false)
        expect(opened.reason).toContain("signature does not verify")
    })
})
