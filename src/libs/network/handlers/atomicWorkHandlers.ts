import { uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"

import { isForkActive } from "@/forks"
import { atomicWorkCapability, capabilityDigest } from "@/libs/atomic-work/capability"
import { DEFAULT_ATOMIC_WORK_LIMITS } from "@/libs/atomic-work/limits"
import { atomicWorkProfile } from "@/libs/atomic-work/profile"
import { computeReceiptCommitment } from "@/libs/atomic-work/receiptCommitment"
import Chain from "@/libs/blockchain/chain"
import Mempool from "@/libs/blockchain/mempool"
import TxValidatorPool from "@/libs/blockchain/validation/txValidatorPool"
import Hashing from "@/libs/crypto/hashing"
import { jcsCanonicalize } from "@/libs/crypto/jcs"
import { dataSource } from "@/model/datasource"
import { GCRAtomicWork } from "@/model/entities/GCRv2/GCR_AtomicWork"
import { GCRResourceSlot } from "@/model/entities/GCRv2/GCR_ResourceSlot"
import { Transactions } from "@/model/entities/Transactions"
import log from "@/utilities/logger"
import { getSharedState } from "@/utilities/sharedState"
import type { NodeCallHandler } from "./types"

/**
 * Reading Works back: their receipts, their lifecycle state, and what this
 * node can execute. Everything is answered from finalized chain data this
 * node holds, never from an indexer, and state answers are signed so a
 * client can hold a node to what it said.
 */

const CAPABILITY_DOMAIN = "demos-atomic-capability:v1:"

type WorkState =
    | "included-committed"
    | "included-replay"
    | "included-failed"
    | "pending"
    | "unknown"

function active(): boolean {
    return isForkActive("atomicWork", getSharedState.lastBlockNumber ?? 0)
}

function parsedContent(row: Transactions): Record<string, any> {
    const content = row.content as unknown
    return typeof content === "string" ? JSON.parse(content) : (content as Record<string, any>)
}

function workAttemptOf(content: Record<string, any>): Record<string, any> | undefined {
    return (content?.gcr_edits ?? []).find((e: { type: string }) => e.type === "work-attempt")
}

async function sign(statement: Record<string, unknown>) {
    const digest = Hashing.sha256(jcsCanonicalize(statement))
    const signature = await TxValidatorPool.getInstance().sign(
        getSharedState.signingAlgorithm,
        new TextEncoder().encode(digest),
    )
    return {
        statement,
        attestation: {
            signer: getSharedState.publicKeyHex,
            algorithm: getSharedState.signingAlgorithm,
            digest,
            signature: uint8ArrayToHex(signature.signature),
        },
    }
}

async function blockOf(number: number | null | undefined) {
    if (number === null || number === undefined) return null
    const block = await Chain.getBlockByNumber(number)
    return block ? { number, hash: block.hash } : { number, hash: null }
}

async function pendingForWork(workId: string): Promise<string | null> {
    const pending = await Mempool.getMempool()
    for (const tx of pending as { hash: string; content: Record<string, any> }[]) {
        if (tx.content?.type === "atomicWork" && workAttemptOf(tx.content)?.workId === workId) {
            return tx.hash
        }
    }
    return null
}

async function stateOfWork(workId: string): Promise<Record<string, unknown>> {
    const row = await dataSource.getRepository(GCRAtomicWork).findOneBy({ workId })
    if (row) {
        const tx = await dataSource.getRepository(Transactions).findOneBy({ hash: row.txHash })
        return {
            workId,
            state: "included-committed" satisfies WorkState,
            txHash: row.txHash,
            attemptId: row.winnerAttemptId,
            receiptCommitment: row.receiptCommitment,
            block: await blockOf(tx?.blockNumber),
        }
    }
    const pending = await pendingForWork(workId)
    // Not found is not "never": a Work this node has not seen may still be
    // included elsewhere, so absence is reported as indeterminate.
    return pending
        ? { workId, state: "pending" satisfies WorkState, txHash: pending }
        : { workId, state: "unknown" satisfies WorkState }
}

async function stateOfTx(hash: string): Promise<Record<string, unknown>> {
    const row = await dataSource.getRepository(Transactions).findOneBy({ hash })
    if (row) {
        const content = parsedContent(row)
        const attempt = workAttemptOf(content)
        const failed = String(row.status) === "failed"
        const state: WorkState = failed
            ? "included-failed"
            : attempt?.attemptClass === "replay"
              ? "included-replay"
              : "included-committed"
        return {
            txHash: hash,
            workId: attempt?.workId ?? null,
            attemptId: attempt?.attemptId ?? null,
            state,
            block: await blockOf(row.blockNumber),
        }
    }
    if (await Mempool.findByHash(hash)) return { txHash: hash, state: "pending" satisfies WorkState }
    return { txHash: hash, state: "unknown" satisfies WorkState }
}

export const atomicWorkHandlers: Record<string, NodeCallHandler> = {
    /**
     * What this node enforces for atomic Works. Advertised only once the
     * `atomicWork` fork is active: before that the node executes no Work,
     * and saying otherwise would invite submitters to sign one.
     */
    getAtomicWorkCapability: async (_data, response) => {
        if (!active()) {
            response.result = 200
            response.response = { advertised: false }
            return response
        }
        const capability = atomicWorkCapability(String(getSharedState.version), DEFAULT_ATOMIC_WORK_LIMITS)
        response.result = 200
        response.response = {
            advertised: true,
            capability,
            digest: capabilityDigest(capability, CAPABILITY_DOMAIN),
        }
        return response
    },

    /**
     * A Work's receipt, as committed on chain, with the block it landed in
     * and the slots it moved. The commitment is recomputed on the way out, so
     * the answer carries its own integrity check.
     */
    getAtomicWorkReceipt: async (data, response) => {
        const workId = data?.workId
        if (typeof workId !== "string" || !workId) {
            response.result = 400
            response.response = "workId is required"
            return response
        }
        try {
            const row = await dataSource.getRepository(GCRAtomicWork).findOneBy({ workId })
            if (!row?.receipt) {
                response.result = 404
                response.response = "no committed receipt for this Work on this node"
                return response
            }
            const profile = atomicWorkProfile(row.receipt.profile as string)
            const recomputed = profile
                ? computeReceiptCommitment(row.receipt, profile.domains.workReceipt)
                : null
            const tx = await dataSource.getRepository(Transactions).findOneBy({ hash: row.txHash })
            const slots = await dataSource.getRepository(GCRResourceSlot).findBy({ workId })

            response.result = 200
            response.response = {
                workId,
                receipt: row.receipt,
                receiptCommitment: row.receiptCommitment,
                operationReceiptRoot: row.operationReceiptRoot,
                verified: recomputed !== null && recomputed === row.receiptCommitment,
                txHash: row.txHash,
                block: await blockOf(tx?.blockNumber),
                slots: slots.map(s => s.record),
            }
        } catch (error) {
            log.error(`[atomicWork] receipt lookup failed: ${error}`)
            response.result = 500
            response.response = "receipt lookup failed"
        }
        return response
    },

    /**
     * Where a Work, or a Work transaction, stands: committed, replayed,
     * included as failed, pending, or unknown to this node. Signed by the
     * node, with the height it answered at.
     */
    getAtomicWorkStatus: async (data, response) => {
        const workId = data?.workId
        const txHash = data?.txHash
        if ((typeof workId !== "string" || !workId) && (typeof txHash !== "string" || !txHash)) {
            response.result = 400
            response.response = "workId or txHash is required"
            return response
        }
        try {
            const status = typeof txHash === "string" && txHash ? await stateOfTx(txHash) : await stateOfWork(workId)
            response.result = 200
            response.response = await sign({
                ...status,
                observedAtHeight: getSharedState.lastBlockNumber ?? 0,
            })
        } catch (error) {
            log.error(`[atomicWork] status lookup failed: ${error}`)
            response.result = 500
            response.response = "status lookup failed"
        }
        return response
    },
}
