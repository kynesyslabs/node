/**
 * RPC admission of an L2PS transfer once signatureDomain is active: an SDK
 * client signs the inner transaction over `demos-tx:v1:<chainId>:<hash>`, and
 * the node must open it with its chain id. The legacy bare-hash form and a
 * signature for another chain are refused, as L1 refuses them; rows already
 * queued before activation still count against the sender. Before activation
 * nothing changes. Envelopes are built, signed and sealed by the real SDK; the
 * stores, the executor and the L1 signature check are replaced.
 */

import { afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test"

const check = jest.fn()
const claim = jest.fn()
const release = jest.fn()
const settle = jest.fn()
const guard = { check, claim, release, settle, retryAfterMs: 10_000 }
const updateStatus = jest.fn(async (..._args: unknown[]) => true)
const execute = jest.fn(async (..._args: unknown[]): Promise<any> => ({ success: true, gcr_edits: [] }))
const addTransaction = jest.fn(async (..._args: unknown[]): Promise<{ success: boolean; error?: string }> => ({ success: true }))
const existsByOriginalHash = jest.fn(async (..._args: unknown[]) => false)
/** The subnet the node is a member of; envelopes are opened with its real SDK instance. */
let member: unknown = null
const getL2PS = jest.fn(async (..._args: unknown[]) => member)
const confirmTx = jest.fn(async (..._args: unknown[]) => ({ success: true }))
const recordTransaction = jest.fn(async (..._args: unknown[]): Promise<void> => undefined)
const updateTransactionStatus = jest.fn(async (..._args: unknown[]): Promise<void> => undefined)
/** Queue rows no longer settleable (refused, or never marked executed). */
let stranded = new Set<string>()
/** History rows of the sender's queued transfers, holding real envelopes. */
let unsettled: { l2ps_uid: string; nonce: bigint; encrypted_hash: string; encrypted_payload: unknown }[] = []

mock.module("src/libs/blockchain/chain", () => ({ __esModule: true, default: {} }))
mock.module("src/libs/blockchain/transaction", () => ({ __esModule: true, default: { confirmTx } }))
mock.module("../../server_rpc", () => ({
    emptyResponse: { result: 200, response: "", require_reply: false, extra: null },
}))
mock.module("@/libs/l2ps/parallelNetworks", () => ({
    __esModule: true,
    default: { getInstance: () => ({ getL2PS, loadL2PS: getL2PS }) },
}))
mock.module("@/libs/blockchain/l2ps_mempool", () => ({
    __esModule: true,
    default: {
        addTransaction,
        existsByOriginalHash,
        updateStatus,
        updateGCREdits: async () => true,
        getSettleableHashes: async (hashes: string[]) => new Set(hashes.filter(h => !stranded.has(h))),
    },
}))
mock.module("@/libs/l2ps/L2PSTransactionExecutor", () => ({
    __esModule: true,
    L2PS_TX_FEE: 1,
    default: {
        hasExecuted: async () => false,
        execute,
        recordTransaction,
        updateTransactionStatus,
        // As the queries read them: the subnets with unsettled rows, and one
        // subnet's page of rows past the given L2PS nonce.
        getUnsettledSubnetsOf: async () => [...new Set(unsettled.map(row => row.l2ps_uid))].sort(),
        getUnsettledBySender: async (_from: string, uid: string, nonce: bigint, limit: number, offset = 0) =>
            unsettled.filter(row => row.l2ps_uid === uid && row.nonce > nonce).slice(offset, offset + limit),
    },
}))
const checkInnerTxBalance = jest.fn(async (..._args: unknown[]): Promise<string | null> => null)
mock.module("@/libs/l2ps/balanceCheck", () => ({ checkInnerTxBalance }))
/** Balance and L2PS nonces per account; the L1 nonce is never read. */
let tipAccounts = new Map<string, { balance: bigint; l2psNonces: Record<string, number> }>()
mock.module("@/libs/l2ps/settlement/tipState", () => ({
    readTipAccounts: async (accounts: Iterable<string>, l2psUid: string) => {
        const out = new Map<string, { balance: bigint; nonce: bigint; l2psNonces: Record<string, number> }>()
        for (const a of accounts) {
            const state = tipAccounts.get(a) ?? { balance: 0n, l2psNonces: {} }
            out.set(a, { ...state, nonce: BigInt(state.l2psNonces[l2psUid] ?? 0) })
        }
        return out
    },
}))
mock.module("@/libs/l2ps/executedBacklogGuard", () => ({
    __esModule: true,
    L2PS_BACKLOG_FULL: "L2PS_BACKLOG_FULL",
    backlogFullMessage: (ms: number) => `L2PS_BACKLOG_FULL: retryAfterMs=${ms}`,
    getExecutedBacklogGuard: () => guard,
}))
const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), warning: jest.fn(), error: jest.fn(), only: jest.fn() }
mock.module("@/utilities/logger", () => ({ __esModule: true, default: logger }))


import type { L2PS } from "@kynesyslabs/demosdk/l2ps"
import { cloneDefaultForkConfig } from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"
import { INNER_TX_NOT_DOMAIN_SIGNED } from "@/libs/l2ps/innerTxDecrypt"
import { OS, sealed, settledTransfer, signer, subnet } from "@/libs/l2ps/__fixtures__/chainSignedTransfer"

const { default: handleL2PS } = await import("./handleL2PS")

const CHAIN = 4242
const UID = "chain_id_subnet"

const saved = {
    forkConfig: getSharedState.forkConfig,
    lastBlockNumber: getSharedState.lastBlockNumber,
    chainId: getSharedState.chainId,
    networkFee: getSharedState.networkFee,
    rpcFee: getSharedState.rpcFee,
    additionalFee: getSharedState.additionalFee,
}

const domainSigner = () => signer({ domain: true, chainId: CHAIN })
const legacySigner = () => signer({ domain: false, chainId: CHAIN })
const foreignSigner = () => signer({ domain: true, chainId: CHAIN + 1 })

let l2ps: L2PS
let sender: string

/** Records `inner`, sealed, as a transfer this node already queued. */
async function queued(inner: any): Promise<void> {
    const envelope = await sealed(l2ps, inner)
    unsettled.push({ l2ps_uid: UID, nonce: BigInt(inner.content.nonce), encrypted_hash: envelope.hash, encrypted_payload: envelope })
}

/** l2psSettlement on from genesis, signatureDomain from `height` (null: never), tip at 100. */
function chain(height: number | null): void {
    getSharedState.forkConfig = cloneDefaultForkConfig()
    getSharedState.forkConfig.l2psSettlement.activationHeight = 0
    getSharedState.forkConfig.signatureDomain.activationHeight = height
    getSharedState.lastBlockNumber = 100
}

beforeEach(async () => {
    chain(0)
    getSharedState.chainId = CHAIN
    getSharedState.networkFee = 1
    getSharedState.rpcFee = 1
    getSharedState.additionalFee = 1
    l2ps = await subnet(UID)
    member = l2ps
    sender = ((await (await domainSigner()).getEd25519Address()) as string).toLowerCase()
    tipAccounts = new Map([[sender, { balance: 100n * OS, l2psNonces: { [UID]: 4 } }]])
    unsettled = []
    stranded = new Set()
    check.mockResolvedValue({ admitted: true, count: 1, cap: 50_000, retryAfterMs: 10_000 })
    claim.mockReturnValue(true)
    addTransaction.mockReset()
    addTransaction.mockResolvedValue({ success: true })
    updateStatus.mockReset()
    updateStatus.mockResolvedValue(true)
    existsByOriginalHash.mockResolvedValue(false)
    recordTransaction.mockReset()
    recordTransaction.mockResolvedValue(undefined)
    confirmTx.mockClear()
})

afterEach(() => {
    Object.assign(getSharedState, saved)
})

describe("handleL2PS after signatureDomain activation", () => {
    it("admits a transfer an SDK client signed for this chain", async () => {
        const response = await handleL2PS(await sealed(l2ps, await settledTransfer(await domainSigner(), UID)))
        expect(response.extra).toBeNull()
        expect(response.result).toBe(200)
        expect(addTransaction).toHaveBeenCalledTimes(1)
    })

    it("refuses a legacy bare-hash signature before the L1 check runs", async () => {
        const response = await handleL2PS(await sealed(l2ps, await settledTransfer(await legacySigner(), UID)))
        expect(response.result).toBe(400)
        expect(String(response.extra)).toContain(INNER_TX_NOT_DOMAIN_SIGNED)
        expect(confirmTx).not.toHaveBeenCalled()
        expect(addTransaction).not.toHaveBeenCalled()
    })

    it("refuses a transfer signed for another chain", async () => {
        const inner = await settledTransfer(await foreignSigner(), UID, { settlementChainId: CHAIN })
        const response = await handleL2PS(await sealed(l2ps, inner))
        expect(response.result).toBe(400)
        expect(String(response.extra)).toContain("signature does not verify")
        expect(addTransaction).not.toHaveBeenCalled()
    })

    it("opens queued rows signed either way, so each still counts against the balance", async () => {
        await queued(await settledTransfer(await legacySigner(), UID, { nonce: 5, amount: 40n * OS }))
        await queued(await settledTransfer(await domainSigner(), UID, { nonce: 6, amount: 40n * OS }))

        const fits = await handleL2PS(await sealed(l2ps, await settledTransfer(await domainSigner(), UID, { nonce: 7, amount: 10n * OS })))
        expect(fits.extra).toBeNull()
        expect(fits.result).toBe(200)

        const over = await handleL2PS(await sealed(l2ps, await settledTransfer(await domainSigner(), UID, { nonce: 7, amount: 20n * OS })))
        expect(over.result).toBe(400)
        expect(String(over.extra)).toContain("Insufficient balance")
    })

    it("refuses the sender while a queued row signed for another chain cannot be opened", async () => {
        await queued(await settledTransfer(await foreignSigner(), UID, { nonce: 5, settlementChainId: CHAIN }))
        const response = await handleL2PS(await sealed(l2ps, await settledTransfer(await domainSigner(), UID, { nonce: 6 })))
        expect(response.result).toBe(400)
        expect(String(response.extra)).toContain("queued transfers")
    })
})

describe("handleL2PS before signatureDomain activation", () => {
    beforeEach(() => chain(null))

    it("admits a legacy-signed transfer, as before", async () => {
        const response = await handleL2PS(await sealed(l2ps, await settledTransfer(await legacySigner(), UID)))
        expect(response.extra).toBeNull()
        expect(response.result).toBe(200)
    })

    it("refuses a domain-signed transfer, as L1 does before activation", async () => {
        const response = await handleL2PS(await sealed(l2ps, await settledTransfer(await domainSigner(), UID)))
        expect(response.result).toBe(400)
        expect(String(response.extra)).toContain("signature does not verify")
    })
})
