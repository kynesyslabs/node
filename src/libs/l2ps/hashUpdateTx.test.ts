/**
 * The hash service's l2ps_hash_update is built and signed with the node
 * identity, the way the node builds its other transactions. On the launch
 * rehearsal it went through an SDK wallet the node never connects, and every
 * cycle failed with "Wallet not connected".
 *
 * The built tx is judged by the node's own admission rules: structure, hash
 * coherence at the tip, the signature over the chain's preimage, the shipped
 * fee against the breakdown and the edits against the regenerated set.
 */
import { afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test"
import forge from "node-forge"

const pair = forge.pki.ed25519.generateKeyPair({ seed: new Uint8Array(32).fill(5) })
const PUBKEY = new Uint8Array(pair.publicKey)
const IDENTITY = "0x" + Buffer.from(PUBKEY).toString("hex")
const TIP = 541
const UID = "rehearsal_l2ps_816"

const confirmed: any[] = []
const loud: string[] = []
const listPendingBySenders = jest.fn(async (..._args: unknown[]) => [{ hash: "p", sender: IDENTITY, nonce: "9", type: "native" }])
const getAccountNonce = jest.fn(async (..._args: unknown[]) => 7)

mock.module("@/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: () => undefined,
        info: () => undefined,
        only: () => undefined,
        warn: (...a: unknown[]) => loud.push(a.join(" ")),
        warning: (...a: unknown[]) => loud.push(a.join(" ")),
        error: (...a: unknown[]) => loud.push(a.join(" ")),
    },
}))
mock.module("@/libs/blockchain/l2ps_mempool", () => ({
    __esModule: true,
    default: { getDigestWithCount: async () => ({ hash: "ab".repeat(32), count: 3 }) },
    L2PS_STATUS: { EXECUTED: "executed" },
}))
mock.module("@/libs/blockchain/mempool", () => ({ __esModule: true, default: { listPendingBySenders } }))
mock.module("@/libs/blockchain/chain", () => ({
    __esModule: true,
    default: { getLastBlockNumber: async () => TIP, checkTxExists: async () => false },
}))
mock.module("@/libs/blockchain/gcr/gcr", () => ({ __esModule: true, default: { getAccountNonce } }))
mock.module("@/libs/blockchain/validation/txValidatorPool", () => ({
    __esModule: true,
    default: {
        getInstance: () => ({
            sign: async (_alg: string, data: Uint8Array) => ({
                signature: new Uint8Array(forge.pki.ed25519.sign({ message: Buffer.from(data), privateKey: pair.privateKey })),
            }),
        }),
    },
}))
mock.module("@/libs/blockchain/routines/validateTransaction", () => ({
    confirmTransaction: async (tx: unknown) => {
        confirmed.push(tx)
        return { data: { valid: true, transaction: tx, message: "" } }
    },
}))

import { cloneDefaultForkConfig } from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"
import { serializeTransactionContent, txSignaturePreimageForPendingBlock } from "@/forks"
import { Hashing } from "@kynesyslabs/demosdk/encryption"
import { calculateFeeBreakdown } from "@/libs/blockchain/routines/calculateCurrentGas"
import { shippedFeeMismatch } from "@/libs/blockchain/validation/feeBinding"
import { generateGcrEdits } from "@/libs/blockchain/validation/generateGcrEdits"

const { default: Transaction } = await import("@/libs/blockchain/transaction")
const { validateTxSignature } = await import("@/libs/blockchain/validation/txValidator")
const { L2PSHashService } = await import("./L2PSHashService")

const saved = {
    forkConfig: getSharedState.forkConfig,
    lastBlockNumber: getSharedState.lastBlockNumber,
    keypair: getSharedState.keypair,
    signingAlgorithm: getSharedState.signingAlgorithm,
    chainId: getSharedState.chainId,
    networkFee: getSharedState.networkFee,
    rpcFee: getSharedState.rpcFee,
    additionalFee: getSharedState.additionalFee,
}

beforeEach(() => {
    // The hash service runs before l2psSettlement; signatures and amounts as on mainnet.
    const forks = cloneDefaultForkConfig()
    forks.osDenomination.activationHeight = 0
    forks.signatureDomain.activationHeight = 0
    getSharedState.forkConfig = forks
    getSharedState.lastBlockNumber = TIP
    getSharedState.chainId = 4242
    ;(getSharedState as any).signingAlgorithm = "ed25519"
    ;(getSharedState as any).keypair = { publicKey: PUBKEY, privateKey: new Uint8Array(pair.privateKey) }
    getSharedState.networkFee = 1
    getSharedState.rpcFee = 1
    getSharedState.additionalFee = 0
    confirmed.length = 0
    loud.length = 0
})

afterEach(() => {
    Object.assign(getSharedState, saved)
})

describe("the L2PS hash update", () => {
    it("is built with the node identity, not an SDK wallet", async () => {
        await (L2PSHashService.getInstance() as any).processL2PSNetwork(UID)

        expect(loud.join("\n")).not.toContain("Wallet not connected")
        expect(confirmed).toHaveLength(1)
        const tx = confirmed[0]
        expect(tx.content.type).toBe("l2ps_hash_update")
        expect(tx.content.from).toBe(IDENTITY)
        expect(tx.content.from_ed25519_address).toBe(IDENTITY)
        expect(tx.content.to).toBe(IDENTITY)
        expect(tx.content.data).toEqual([
            "l2ps_hash_update",
            expect.objectContaining({ l2ps_uid: UID, consolidated_hash: "ab".repeat(32), transaction_count: 3 }),
        ])
        // Past the account nonce and every nonce this identity has pending.
        expect(tx.content.nonce).toBe(10)
    })

    it("is not sent under l2psSettlement, whose batches commit every transfer on L1", async () => {
        getSharedState.forkConfig.l2psSettlement.activationHeight = 0
        const service = L2PSHashService.getInstance() as any
        const process = jest.spyOn(service, "generateAndRelayHashes")
        service.isRunning = true
        try {
            await service.safeGenerateAndRelayHashes()
        } finally {
            service.isRunning = false
        }
        expect(process).not.toHaveBeenCalled()
        expect(confirmed).toHaveLength(0)
    })

    it("passes the node's own admission rules", async () => {
        await (L2PSHashService.getInstance() as any).processL2PSNetwork(UID)
        const tx = confirmed[0]

        expect(Transaction.structured(tx).valid).toBe(true)
        expect(tx.hash).toBe(Hashing.sha256(serializeTransactionContent(tx.content, TIP)))
        expect(Transaction.checkCoherence(tx, TIP).coherent).toBe(true)
        const signature = await validateTxSignature(tx, null, {
            active: true,
            chainId: 4242,
        } as any)
        expect(signature.valid).toBe(true)
        expect(
            forge.pki.ed25519.verify({
                message: Buffer.from(txSignaturePreimageForPendingBlock(tx.hash)),
                signature: Buffer.from(tx.signature.data.slice(2), "hex") as any,
                publicKey: Buffer.from(PUBKEY) as any,
            }),
        ).toBe(true)

        expect(shippedFeeMismatch(tx.content.transaction_fee, await calculateFeeBreakdown(tx))).toBeNull()
        const regenerated = JSON.parse(
            serializeTransactionContent({ gcr_edits: await generateGcrEdits({ ...tx, hash: "" }) } as any, TIP),
        ).gcr_edits
        expect(tx.content.gcr_edits).toEqual(regenerated)
    })
})
