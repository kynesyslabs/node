/**
 * The entry node's half of L2PS settlement: turns executed L2PS transfers into
 * proven `l2psBatch` settlement records and follows each batch until it lands.
 * Spec: docs/design/l2ps-zk-settlement.md, "Interface v1.2".
 *
 * Rules this keeps:
 * - A batch is planned on balances and L2PS nonces read at the tip, so no
 *   account a batch in flight touches is planned again until that batch has
 *   landed or failed; otherwise two batches planned on one balance could
 *   together debit more than it holds, and the second would fail at apply.
 *   The proof binds no balance, so L1 activity on a touched account while a
 *   batch proves does not make it stale; only a balance that no longer
 *   covers the account's net debit fails it.
 * - A transfer that cannot go into this batch (overdraft, nonce gap, slots)
 *   stays queued; one whose L2PS nonce is already spent, or whose signed fee is
 *   below the native transfer fee now, can never settle and is dropped with a
 *   history status, so no batch that apply must fail is proved again and again.
 * - Transfers the planner cannot place at all are deferred: read in a window
 *   of their own, so they never crowd fresh transfers out of the queue window,
 *   and failed once SETTLEMENT_DEFERRED_TTL_BLOCKS have passed since admission.
 * - A batch L1 includes as failed, or that expires unseen, puts its transfers
 *   back in the queue to be planned and proved again. Re-sending a transfer is
 *   safe: whichever batch lands second fails on its spent nonce.
 * - A cycle plans at most `provers` batches, on the accounts no batch in
 *   flight or planned before it touches, across subnets too, proves them all
 *   at once and submits them in plan order: the same queue and tip give the
 *   same batches and the same submission order however the proofs
 *   interleave. A batch planned only to wait for a prover would bind a tip
 *   that is older by a proof time for each batch ahead of it.
 * - Subnets are visited from a starting subnet that moves by one each cycle,
 *   so a subnet sharing an account with another is not always the one that
 *   finds it claimed.
 * - Proving runs in the prover subprocesses; when a proof fails, or the
 *   mempool refuses a batch, the subnet waits with a growing back-off instead
 *   of retrying every cycle, and other subnets go on.
 * - A transfer whose batch failed SUSPECT_AFTER_FAILURES times, at proving,
 *   at a mempool refusal no retry can change, or on L1 at the tip it was
 *   proved on, is proved alone from then on, so the transfers it was batched
 *   with settle without it. One that also fails alone that often is dropped,
 *   but only once a proof or batch of someone else has worked since its
 *   first failure alone: a prover or verifier that fails everything drops
 *   nothing. Failures that say nothing about the transfers (a full mempool,
 *   an L2PS nonce spent elsewhere, a shutdown) are never counted.
 * - A batch that fails on L1 because an account no longer covers its net
 *   debit (its owner spent the balance on L1 while the batch proved) is
 *   re-planned on the tip: the transfers of that signer the batch can no
 *   longer carry are dropped, the rest are queued again, and none is blamed.
 */
import type { L2PSMempoolTx } from "@/model/entities/L2PSMempool"
import type { TxStatus } from "@/libs/blockchain/chainTypes"
import { L2PS_STATUS, type L2PSStatus } from "@/libs/blockchain/l2ps_mempool"
import log from "@/utilities/logger"
import { getErrorMessage } from "@/utilities/errorMessage"
import { SETTLEMENT_VERSION, fieldToHex } from "./encoding"
import type { TransferVerdict } from "./transfer"
import type { TipAccount } from "./tipState"
import type {
    DecryptedTransfer,
    SettlementChange,
    SettlementPlan,
    SettlementProofResult,
} from "./types"
import type { SettlementRecord } from "./validation"

export type HistoryStatus = "pending" | "batched" | "confirmed" | "failed"

/**
 * A mempool refusal is permanent when the same batch would be refused again
 * whatever the pool holds (unstorable, larger than a block), and transient
 * otherwise (pool full, a database error).
 */
export type SubmitResult =
    | { ok: true; l1TxHash: string }
    | {
          ok: false
          permanent: boolean
          reason: string
          /** The mempool insert threw: the batch may be in, so it is followed, not re-queued. */
          maybeSent?: boolean
      }

/**
 * What a submission asks of the loop just before the batch enters the
 * mempool, after its hash is known and every slow step (nonce, signature,
 * tip) is done.
 */
export interface SubmitGate {
    /** True once the loop is closed: a batch not yet in the mempool stays out. */
    stopped(): boolean
    /**
     * Durably ties the rows to the batch about to go out. Throws to keep the
     * batch out of the mempool: a batch that lands with its rows still
     * queued is planned again and its transfers fail on their spent nonces.
     */
    beforeSend(l1TxHash: string): Promise<void>
}

/** Everything the settlement loop touches outside itself, injectable for tests. */
export interface SettlementDeps {
    /** Subnets with rows in `status`. */
    subnets(status: L2PSStatus): Promise<string[]>
    /** Rows in queue order from `offset`; throws when the read fails, so a failed read is never an empty queue. */
    rows(l2psUid: string, status: L2PSStatus, limit: number, offset?: number): Promise<L2PSMempoolTx[]>
    /** Decrypts a queued row and opens its settlement transfer. Throws when the subnet cannot decrypt at all. */
    open(l2psUid: string, row: L2PSMempoolTx): Promise<TransferVerdict>
    /** Balances and L2PS nonces in `l2psUid` at the tip. */
    tip(l2psUid: string, accounts: Iterable<string>): Promise<Map<string, TipAccount>>
    /** The native transfer fee now, in OS: the floor block apply holds each transfer's fee to. */
    minimumFee(): Promise<bigint>
    plan(
        transfers: DecryptedTransfer[],
        balances: Map<string, bigint>,
        nonces: Map<string, bigint>,
    ): SettlementPlan
    prove(plan: SettlementPlan): Promise<SettlementProofResult>
    /** Submits the batch to the mempool, through `gate` right before it goes in. */
    submit(
        l2psUid: string,
        record: SettlementRecord,
        rows: L2PSMempoolTx[],
        gate: SubmitGate,
    ): Promise<SubmitResult>
    status(l1TxHash: string): Promise<TxStatus>
    setRows(hashes: string[], status: L2PSStatus): Promise<void>
    history(
        txHash: string,
        status: HistoryStatus,
        message: string,
        l1BatchHash?: string,
        l1BlockNumber?: number,
    ): Promise<void>
    /** The L1 batch a history row was last batched into, for recovery after a restart. */
    historyBatchHash(l2psUid: string, row: L2PSMempoolTx): Promise<string | null>
    /** The rows among `rowHashes` whose history already reads failed. */
    failedInHistory(rowHashes: string[]): Promise<Set<string>>
    head(): number
    now(): number
}

/**
 * Blocks after admission a deferred transfer may wait for its balance or its
 * nonce turn before it fails: about 35 minutes at 7 s blocks. A constant, so
 * a sender sees the same deadline on every member.
 */
export const SETTLEMENT_DEFERRED_TTL_BLOCKS = 300

export interface SettlementLimits {
    minBatchSize: number
    maxBatchesPerCycle: number
    /** Rows read per subnet per cycle. */
    queueWindow: number
    /** Blocks after which a batch the chain has not seen can no longer be included. */
    expiryBlocks: number
    /** Blocks after admission a deferred transfer fails at. */
    deferredTtlBlocks: number
    proverBackoffMs: number
    proverBackoffMaxMs: number
    /** Proofs made at once: the size of the prover pool. */
    provers: number
}

interface InFlightBatch {
    l2psUid: string
    l1TxHash: string
    rowHashes: string[]
    accounts: Set<string>
    submittedAt: number
    /** Proved alone, to isolate a transfer earlier batches failed with. */
    alone: boolean
    /** Balances and L2PS nonces of its accounts it was planned on; unknown after a restart. */
    bound?: Map<string, TipAccount>
    /** Its transfers and net changes; unknown after a restart. */
    transfers?: DecryptedTransfer[]
    changes?: SettlementChange[]
    /** Block the batch landed in; its accounts unlock once the tip is past it. */
    landedAt?: number
}

/** Failed batches, at proving or on L1, after which a transfer is proved alone. */
export const SUSPECT_AFTER_FAILURES = 2

type FailureKind = "prove" | "submit" | "l1"

/** A batch planned this cycle, waiting for its proof. */
interface PlannedBatch {
    l2psUid: string
    plan: SettlementPlan
    rows: L2PSMempoolTx[]
    accounts: Set<string>
    alone: boolean
    bound: Map<string, TipAccount>
}

type ProveOutcome =
    | { ok: true; proof: SettlementProofResult; ms: number }
    | { ok: false; error: unknown }

interface CycleTally {
    submitted: number
    transfers: number
    failed: Set<string>
    worked: Set<string>
}

/**
 * An L1 failure that says nothing about the batch's transfers: the batch
 * waited past its reference block's window, as any batch can under load.
 */
const NOT_THE_TRANSFERS = new Set(["TX_EXPIRED_REFERENCE_BLOCK_OUT_OF_RANGE"])

/** Why a transfer's batches failed, for isolating the transfer that breaks them. */
interface Blame {
    /** Failed batches it shared with other transfers. */
    group: number
    /** Failed batches it was alone in. */
    alone: number
    /** Proofs made, batches submitted and batches landed when it first failed alone. */
    provedAt: number
    submittedAt: number
    landedAt: number
}

export function settlementRecord(
    plan: SettlementPlan,
    proof: SettlementProofResult,
): SettlementRecord {
    return {
        version: SETTLEMENT_VERSION,
        transfers: plan.transfers.map(t => ({
            commitment: fieldToHex(t.commitment),
            signer: t.from,
            nonce: t.nonce.toString(),
            fee: t.fee.toString(),
            signature: t.signature,
        })),
        changes: plan.changes.map(c => ({ account: c.account, delta: c.delta.toString() })),
        proof: proof.proof,
    }
}

export class SettlementAggregator {
    private readonly inFlight = new Map<string, InFlightBatch>()
    private recovered = false
    /** Prover back-off per subnet: one subnet's failing proofs do not pause the others. */
    private readonly proverPause = new Map<string, { failures: number; until: number }>()
    private readonly blame = new Map<string, Blame>()
    private proofsMade = 0
    private batchesSubmitted = 0
    private batchesLanded = 0
    private cycles = 0
    private closed = false

    constructor(
        private readonly deps: SettlementDeps,
        private readonly limits: SettlementLimits,
    ) {}

    /** Rows of batches not yet settled, by L1 tx hash; for tests and stats. */
    inFlightBatches(): ReadonlyMap<string, InFlightBatch> {
        return this.inFlight
    }

    /** Failed batches counted against a transfer; for tests and stats. */
    failuresOf(hash: string): { group: number; alone: number } | undefined {
        const blame = this.blame.get(hash)
        return blame && { group: blame.group, alone: blame.alone }
    }

    /**
     * Stops the loop for good: no proof starts and no batch goes out after
     * this. A proof the shutdown cuts short fails for the shutdown's sake,
     * so it is never counted against its transfers.
     */
    close(): void {
        this.closed = true
    }

    /** One aggregation cycle; the caller paces cycles and keeps them from overlapping. */
    async cycle(): Promise<{ submitted: number; transfers: number }> {
        if (this.closed) return { submitted: 0, transfers: 0 }
        if (!this.recovered) {
            // Throws on a failed read, so the next cycle recovers again
            // instead of planning around batches it does not know of.
            await this.recoverBatched()
            this.recovered = true
        }
        await this.track()

        const subnets = [
            ...new Set([
                ...(await this.deps.subnets(L2PS_STATUS.EXECUTED)),
                ...(await this.deps.subnets(L2PS_STATUS.DEFERRED)),
            ]),
            // Code-unit order, not a locale's: every node plans the same order.
        ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        const first = subnets.length > 0 ? this.cycles % subnets.length : 0
        this.cycles++
        const order = [...subnets.slice(first), ...subnets.slice(0, first)]

        // A proof binds the tip balances of its accounts, so no two batches
        // waiting to land may share one, whichever subnet planned them.
        const claimed = this.lockedAccounts()
        const slots = Math.max(1, Math.floor(this.limits.provers))
        const planned: PlannedBatch[] = []
        const planFailed = new Set<string>()
        for (const l2psUid of order) {
            if (planned.length >= slots) break
            if (this.deps.now() < (this.proverPause.get(l2psUid)?.until ?? 0)) continue
            try {
                // Claimed on a copy: a subnet whose planning fails submits
                // nothing, so its accounts stay free for the subnets after it.
                const claims = new Set(claimed)
                planned.push(...(await this.planSubnet(l2psUid, claims, slots - planned.length)))
                for (const account of claims) claimed.add(account)
            } catch (error) {
                // A failed read or write here stops only this subnet, which
                // backs off; the others still settle.
                planFailed.add(l2psUid)
                log.error(`[L2PS Settlement] Planning ${l2psUid} failed; transfers stay queued: ${getErrorMessage(error)}`)
            }
        }
        if (this.closed) return { submitted: 0, transfers: 0 }

        const tally: CycleTally = { submitted: 0, transfers: 0, failed: planFailed, worked: new Set() }
        const outcomes = planned.map(batch => this.prove(batch))
        for (const [i, batch] of planned.entries()) {
            // Each batch goes out once it and every batch planned before it
            // are proved, while the later ones keep proving.
            const outcome = await outcomes[i]
            if (this.closed) break
            try {
                await this.settleBatch(batch, outcome, tally)
            } catch (error) {
                // Only this batch is lost: the proofs after it are already
                // running and still go out.
                tally.failed.add(batch.l2psUid)
                log.error(
                    `[L2PS Settlement] Settling a ${batch.plan.transfers.length}-transfer batch for ${batch.l2psUid} failed; transfers stay queued: ${getErrorMessage(error)}`,
                )
            }
        }
        if (this.closed) return { submitted: tally.submitted, transfers: tally.transfers }

        for (const l2psUid of tally.worked) if (!tally.failed.has(l2psUid)) this.proverPause.delete(l2psUid)
        for (const l2psUid of tally.failed) {
            const failures = (this.proverPause.get(l2psUid)?.failures ?? 0) + 1
            const pause = Math.min(this.limits.proverBackoffMs * 2 ** (failures - 1), this.limits.proverBackoffMaxMs)
            this.proverPause.set(l2psUid, { failures, until: this.deps.now() + pause })
            log.warning(`[L2PS Settlement] ${l2psUid}: next settlement attempt in ${pause} ms`)
        }
        return { submitted: tally.submitted, transfers: tally.transfers }
    }

    private async prove(batch: PlannedBatch): Promise<ProveOutcome> {
        const since = this.deps.now()
        try {
            const proof = await this.deps.prove(batch.plan)
            return { ok: true, proof, ms: this.deps.now() - since }
        } catch (error) {
            return { ok: false, error }
        }
    }

    /** Submits one proved batch, or counts its failure against its subnet and, when the failure is theirs, its transfers. */
    private async settleBatch(batch: PlannedBatch, outcome: ProveOutcome, tally: CycleTally): Promise<void> {
        const { l2psUid, plan } = batch
        const hashes = plan.transfers.map(t => t.txHash)
        if (outcome.ok === false) {
            tally.failed.add(l2psUid)
            log.error(
                `[L2PS Settlement] Proving a ${plan.transfers.length}-transfer batch for ${l2psUid} failed; transfers stay queued: ${getErrorMessage(outcome.error)}`,
            )
            await this.blameFailure(hashes, batch.alone, "prove")
            return
        }
        this.proofsMade++
        // Proof time bounds a subnet's throughput, so operators need it per batch.
        log.info(
            `[L2PS Settlement] Proved a ${plan.transfers.length}-transfer batch for ${l2psUid} in ${outcome.ms} ms`,
        )

        const rowHashes = batch.rows.map(row => row.hash)
        // The batch link is written before the batch can land, history first:
        // a row that reads batched always finds its batch after a restart.
        const link: { to: string | null } = { to: null }
        const gate: SubmitGate = {
            stopped: () => this.closed,
            beforeSend: async l1TxHash => {
                if (this.closed) throw new Error("the settlement loop is closed")
                link.to = l1TxHash
                for (const hash of rowHashes) {
                    await this.deps.history(hash, "batched", "Included in an L1 settlement batch", l1TxHash)
                }
                await this.deps.setRows(rowHashes, L2PS_STATUS.BATCHED)
            },
        }
        let sent: SubmitResult
        try {
            sent = await this.deps.submit(l2psUid, settlementRecord(plan, outcome.proof), batch.rows, gate)
        } catch (error) {
            sent = { ok: false, permanent: false, reason: getErrorMessage(error) }
        }
        if (sent.ok === false && link.to !== null) {
            if (sent.maybeSent) {
                this.follow(batch, link.to)
                log.warning(
                    `[L2PS Settlement] Batch ${link.to.slice(0, 16)}... for ${l2psUid} may be in the mempool (${sent.reason}); following it until it lands or expires`,
                )
                return
            }
            await this.unlink(batch, link.to, sent.reason)
        }
        if (sent.ok === false && this.closed) {
            // The shutdown kept it out; that says nothing about the transfers.
            log.info(`[L2PS Settlement] A ${plan.transfers.length}-transfer batch for ${l2psUid} was not sent: shutting down`)
            return
        }
        if (sent.ok === false) {
            // Proving it again at once would be refused again; the subnet
            // backs off. Only a refusal no retry can change is counted
            // against the transfers, so one that breaks every batch is
            // isolated while a full pool isolates nothing.
            tally.failed.add(l2psUid)
            log.warning(
                `[L2PS Settlement] The mempool refused a ${plan.transfers.length}-transfer batch for ${l2psUid}; transfers stay queued: ${sent.reason}`,
            )
            if (sent.permanent) await this.blameFailure(hashes, batch.alone, "submit")
            return
        }
        const { l1TxHash } = sent
        this.batchesSubmitted++
        tally.worked.add(l2psUid)
        tally.submitted++
        tally.transfers += plan.transfers.length

        // The mempool holds the batch, so its accounts stay locked until it
        // lands or fails; its rows were marked batched before it went in.
        this.follow(batch, l1TxHash)
        log.info(
            `[L2PS Settlement] Submitted batch ${l1TxHash.slice(0, 16)}... for ${l2psUid}: ${plan.transfers.length} transfers, ${plan.changes.length} accounts`,
        )
    }

    private follow(batch: PlannedBatch, l1TxHash: string): void {
        this.inFlight.set(l1TxHash, {
            l2psUid: batch.l2psUid,
            l1TxHash,
            rowHashes: batch.rows.map(row => row.hash),
            accounts: batch.accounts,
            submittedAt: this.deps.head(),
            alone: batch.alone,
            bound: batch.bound,
            transfers: batch.plan.transfers,
            changes: batch.plan.changes,
        })
    }

    /**
     * Puts the rows of a batch that never entered the mempool back in the
     * queue. When that write fails the batch is followed as if sent: the
     * chain never sees it, so it expires and its rows are queued again then,
     * across a restart too, since the rows still name it.
     */
    private async unlink(batch: PlannedBatch, l1TxHash: string, reason: string): Promise<void> {
        const rowHashes = batch.rows.map(row => row.hash)
        try {
            await this.deps.setRows(rowHashes, L2PS_STATUS.EXECUTED)
        } catch (error) {
            this.follow(batch, l1TxHash)
            log.error(
                `[L2PS Settlement] Batch ${l1TxHash.slice(0, 16)}... was not sent and its rows could not be queued again; they are queued once it expires: ${getErrorMessage(error)}`,
            )
            return
        }
        try {
            for (const hash of rowHashes) {
                await this.deps.history(hash, "pending", `L1 batch not sent: ${reason}`)
            }
        } catch (error) {
            // Only the status a sender reads is stale: the queued row is what plans it.
            log.warning(
                `[L2PS Settlement] Could not record that batch ${l1TxHash.slice(0, 16)}... was not sent: ${getErrorMessage(error)}`,
            )
        }
    }

    /**
     * The in-flight map lives in memory. After a restart, rows still marked
     * batched are tied back to their L1 batch through the history row, and a
     * row whose batch is unknown goes back to the queue.
     */
    private async recoverBatched(): Promise<void> {
        // Every batched row, read in full before anything changes: a row
        // left out would keep its accounts unlocked and stay batched for good.
        const batched = new Map<string, L2PSMempoolTx[]>()
        for (const l2psUid of await this.deps.subnets(L2PS_STATUS.BATCHED)) {
            const rows: L2PSMempoolTx[] = []
            for (;;) {
                const page = await this.deps.rows(l2psUid, L2PS_STATUS.BATCHED, this.limits.queueWindow, rows.length)
                rows.push(...page)
                if (page.length < this.limits.queueWindow) break
            }
            batched.set(l2psUid, rows)
        }
        for (const [l2psUid, rows] of batched) {
            const byBatch = new Map<string, L2PSMempoolTx[]>()
            const orphans: string[] = []
            for (const row of rows) {
                const l1TxHash = await this.deps.historyBatchHash(l2psUid, row)
                if (!l1TxHash) {
                    orphans.push(row.hash)
                    continue
                }
                const group = byBatch.get(l1TxHash) ?? []
                group.push(row)
                byBatch.set(l1TxHash, group)
            }
            if (orphans.length > 0) await this.deps.setRows(orphans, L2PS_STATUS.EXECUTED)
            for (const [l1TxHash, group] of byBatch) {
                const accounts = new Set<string>()
                for (const row of group) {
                    const opened = await this.deps.open(l2psUid, row).catch(() => null)
                    if (opened?.ok) {
                        accounts.add(opened.transfer.from)
                        accounts.add(opened.transfer.to)
                    }
                }
                this.inFlight.set(l1TxHash, {
                    l2psUid,
                    l1TxHash,
                    rowHashes: group.map(row => row.hash),
                    accounts,
                    submittedAt: this.deps.head(),
                    alone: false,
                })
            }
        }
    }

    /** Follows every batch in flight to included, failed or expired. */
    private async track(): Promise<void> {
        const head = this.deps.head()
        for (const batch of [...this.inFlight.values()]) {
            try {
                await this.trackBatch(batch, head)
            } catch (error) {
                // The batch stays in flight, so the next cycle writes its rows
                // again; dropping it here would leave them batched for good.
                log.error(
                    `[L2PS Settlement] Could not record the outcome of batch ${batch.l1TxHash.slice(0, 16)}...; retrying next cycle: ${getErrorMessage(error)}`,
                )
            }
        }
    }

    private async trackBatch(batch: InFlightBatch, head: number): Promise<void> {
        if (batch.landedAt !== undefined) {
            if (head > batch.landedAt) this.inFlight.delete(batch.l1TxHash)
            return
        }
        let status: TxStatus
        try {
            status = await this.deps.status(batch.l1TxHash)
        } catch (error) {
            log.warning(
                `[L2PS Settlement] Could not read the status of batch ${batch.l1TxHash.slice(0, 16)}...: ${getErrorMessage(error)}`,
            )
            return
        }
        if (status.state === "included") {
            // History first: until the rows read confirmed, the batch is
            // followed again, across a restart too (rows still batched).
            for (const hash of batch.rowHashes) {
                await this.deps.history(
                    hash,
                    "confirmed",
                    `Settled on L1 in block ${status.blockNumber}`,
                    batch.l1TxHash,
                    status.blockNumber,
                )
            }
            await this.deps.setRows(batch.rowHashes, L2PS_STATUS.CONFIRMED)
            this.batchesLanded++
            for (const hash of batch.rowHashes) this.blame.delete(hash)
            batch.landedAt = status.blockNumber ?? head
            if (head > batch.landedAt) this.inFlight.delete(batch.l1TxHash)
            log.info(
                `[L2PS Settlement] Batch ${batch.l1TxHash.slice(0, 16)}... settled ${batch.rowHashes.length} transfers for ${batch.l2psUid} in block ${status.blockNumber}`,
            )
            return
        }
        const expired =
            status.state === "unknown" && head - batch.submittedAt > this.limits.expiryBlocks
        if (status.state === "failed" || expired) {
            const why =
                status.state === "failed"
                    ? `L1 batch failed${status.code ? ` (${status.code})` : ""}: re-planning`
                    : "L1 batch expired before inclusion: re-planning"
            await this.deps.setRows(batch.rowHashes, L2PS_STATUS.EXECUTED)
            for (const hash of batch.rowHashes) {
                await this.deps.history(hash, "pending", why, batch.l1TxHash)
            }
            this.inFlight.delete(batch.l1TxHash)
            // An unseen or expired batch says nothing about its transfers.
            if (status.state === "failed" && !NOT_THE_TRANSFERS.has(status.code ?? "")) {
                const explained = await this.explainFailure(batch)
                if (explained === null) {
                    await this.blameFailure(batch.rowHashes, batch.alone, "l1")
                } else {
                    for (const row of explained.drop) {
                        await this.drop(
                            row,
                            "sender's L1 balance no longer covers the transfers it signed in this batch; sign the transfer again",
                        )
                    }
                }
            }
            log.warning(
                `[L2PS Settlement] Batch ${batch.l1TxHash.slice(0, 16)}... for ${batch.l2psUid}: ${why}${status.message ? ` (${status.message})` : ""}`,
            )
        }
    }

    /**
     * What at the tip explains a failed batch, or null when nothing does and
     * the failure counts against its transfers. A failed settlement edits
     * none of its accounts, so the tip shows what another transaction did:
     * a signer's L2PS nonce spent by another batch (its transfers then fail
     * on their spent nonce at the next plan), or an account whose balance no
     * longer covers its net debit. For the latter the batch is re-planned on
     * the tip, and the transfers of such a signer the plan cannot keep are
     * returned to drop: the signer spent what they would draw on. Balance
     * moves that still cover explain nothing: the proof binds no balance.
     * Unknown (after a restart, or an unreadable tip) explains the failure.
     */
    private async explainFailure(batch: InFlightBatch): Promise<{ drop: L2PSMempoolTx[] } | null> {
        if (!batch.bound || !batch.transfers || !batch.changes) return { drop: [] }
        let now: Map<string, TipAccount>
        try {
            now = await this.deps.tip(batch.l2psUid, batch.bound.keys())
        } catch (error) {
            log.warning(
                `[L2PS Settlement] Could not read the tip for failed batch ${batch.l1TxHash.slice(0, 16)}...: ${getErrorMessage(error)}`,
            )
            return { drop: [] }
        }
        for (const t of batch.transfers) {
            if ((now.get(t.from)?.nonce ?? 0n) !== (batch.bound.get(t.from)?.nonce ?? 0n)) {
                return { drop: [] }
            }
        }
        const uncovered = new Set(
            batch.changes
                .filter(c => c.delta < 0n && (now.get(c.account)?.balance ?? 0n) + c.delta < 0n)
                .map(c => c.account),
        )
        if (uncovered.size === 0) return null
        const balances = new Map<string, bigint>()
        const nonces = new Map<string, bigint>()
        for (const [account, state] of now) {
            balances.set(account, state.balance)
            nonces.set(account, state.nonce)
        }
        const kept = new Set(this.deps.plan(batch.transfers, balances, nonces).transfers.map(t => t.txHash))
        const rowOf = new Map(batch.rowHashes.map(hash => [hash, { hash } as L2PSMempoolTx]))
        const drop = batch.transfers
            .filter(t => uncovered.has(t.from) && !kept.has(t.txHash))
            .map(t => rowOf.get(t.txHash))
            .filter((row): row is L2PSMempoolTx => !!row)
        return { drop }
    }

    private lockedAccounts(): Set<string> {
        const locked = new Set<string>()
        for (const batch of this.inFlight.values()) {
            for (const account of batch.accounts) locked.add(account)
        }
        return locked
    }

    /**
     * Counts a failed batch against its transfers, and drops a transfer that
     * failed alone SUSPECT_AFTER_FAILURES times while others still worked.
     */
    private async blameFailure(rowHashes: string[], alone: boolean, kind: FailureKind): Promise<void> {
        for (const hash of rowHashes) {
            const blame = this.blame.get(hash) ?? { group: 0, alone: 0, provedAt: 0, submittedAt: 0, landedAt: 0 }
            if (!alone) {
                blame.group++
                this.blame.set(hash, blame)
                continue
            }
            if (blame.alone === 0) {
                blame.provedAt = this.proofsMade
                blame.submittedAt = this.batchesSubmitted
                blame.landedAt = this.batchesLanded
            }
            blame.alone++
            this.blame.set(hash, blame)
            const othersWorked =
                kind === "prove"
                    ? this.proofsMade > blame.provedAt
                    : kind === "submit"
                      ? this.batchesSubmitted > blame.submittedAt
                      : this.batchesLanded > blame.landedAt
            if (blame.alone >= SUSPECT_AFTER_FAILURES && othersWorked) {
                await this.drop(
                    { hash } as L2PSMempoolTx,
                    kind === "prove"
                        ? `could not be proved, alone, ${blame.alone} times while other transfers were; sign the transfer again`
                        : kind === "submit"
                          ? `its batch was refused by the mempool, alone, ${blame.alone} times while other batches were taken; sign the transfer again`
                          : `its settlement failed on L1, alone, ${blame.alone} times while other batches landed; sign the transfer again`,
                )
            }
        }
    }

    private isSuspect(hash: string): boolean {
        return (this.blame.get(hash)?.group ?? 0) >= SUSPECT_AFTER_FAILURES
    }

    private async drop(row: L2PSMempoolTx, reason: string): Promise<void> {
        // History first: a failed write leaves the row queued, so it is
        // dropped again on the next try, while a failed row is read by
        // nothing that could write its history later.
        await this.deps.history(row.hash, "failed", reason)
        await this.deps.setRows([row.hash], L2PS_STATUS.FAILED)
        // Only once written: the record is what drops it on the next try.
        this.blame.delete(row.hash)
        // A reason can carry the fee or the nonce, which only subnet members may see.
        log.info(`[L2PS Settlement] Dropped transfer ${row.hash.slice(0, 16)}...`)
        log.debug(`[L2PS Settlement] Dropped transfer ${row.hash.slice(0, 16)}...: ${reason}`)
    }

    /**
     * Plans up to `most` of this cycle's batches of a subnet over accounts
     * not in `claimed`, and claims the accounts of each batch it plans.
     */
    private async planSubnet(l2psUid: string, claimed: Set<string>, most: number): Promise<PlannedBatch[]> {
        const batches: PlannedBatch[] = []
        const head = this.deps.head()
        const parked: L2PSMempoolTx[] = []
        for (const row of await this.deps.rows(l2psUid, L2PS_STATUS.DEFERRED, this.limits.queueWindow)) {
            if (head - Number(row.block_number) > this.limits.deferredTtlBlocks) {
                await this.drop(
                    row,
                    `not settled within ${this.limits.deferredTtlBlocks} blocks of admission; sign the transfer again`,
                )
            } else {
                parked.push(row)
            }
        }
        const fresh = await this.deps.rows(l2psUid, L2PS_STATUS.EXECUTED, this.limits.queueWindow)
        // A drop whose history was written but whose row was not: its
        // sender was told it failed, so it must never settle, restart or not.
        const failed = await this.deps.failedInHistory([...fresh, ...parked].map(row => row.hash))
        for (const hash of failed) {
            await this.deps.setRows([hash], L2PS_STATUS.FAILED)
            this.blame.delete(hash)
        }
        const rows = [...fresh, ...parked].filter(row => !failed.has(row.hash))
        if (rows.length < this.limits.minBatchSize) return batches

        const rowOf = new Map<string, L2PSMempoolTx>()
        const opened: DecryptedTransfer[] = []
        for (const row of rows) {
            let verdict: TransferVerdict
            try {
                verdict = await this.deps.open(l2psUid, row)
            } catch (error) {
                // The subnet cannot decrypt (config missing or reloading):
                // nothing about the rows is known, so they stay queued.
                log.warning(`[L2PS Settlement] Cannot open ${l2psUid} transfers: ${getErrorMessage(error)}`)
                return batches
            }
            if (verdict.ok === false) {
                await this.drop(row, verdict.reason)
                continue
            }
            rowOf.set(row.hash, row)
            opened.push(verdict.transfer)
        }
        if (opened.length === 0) return batches

        const tip = await this.deps.tip(l2psUid, opened.flatMap(t => [t.from, t.to]))
        const minimumFee = await this.deps.minimumFee()
        const live: DecryptedTransfer[] = []
        for (const transfer of opened) {
            const l2psNonce = tip.get(transfer.from)?.nonce ?? 0n
            if (transfer.nonce <= l2psNonce) {
                await this.drop(
                    rowOf.get(transfer.txHash)!,
                    `nonce ${transfer.nonce} already spent in this subnet (L2PS nonce ${l2psNonce})`,
                )
                continue
            }
            if (transfer.fee < minimumFee) {
                await this.drop(
                    rowOf.get(transfer.txHash)!,
                    `fee ${transfer.fee} is below the native transfer fee ${minimumFee}; sign the transfer again`,
                )
                continue
            }
            live.push(transfer)
        }

        const balances = new Map<string, bigint>()
        const nonces = new Map<string, bigint>()
        for (const [account, state] of tip) {
            balances.set(account, state.balance)
            nonces.set(account, state.nonce)
        }

        const unclaimed = live.filter(t => !claimed.has(t.from) && !claimed.has(t.to))
        let candidates = unclaimed.filter(t => !this.isSuspect(t.txHash))
        // Fewest failures alone first, so a transfer that keeps failing alone
        // does not stop the others from showing that the prover works.
        let suspects = unclaimed
            .filter(t => this.isSuspect(t.txHash))
            .sort((a, b) => (this.blame.get(a.txHash)?.alone ?? 0) - (this.blame.get(b.txHash)?.alone ?? 0))

        for (let n = 0; n < Math.min(this.limits.maxBatchesPerCycle, most); n++) {
            const alone = suspects.length > 0
            const offered = alone ? [suspects[0]] : candidates
            if (alone) suspects = suspects.slice(1)
            else if (candidates.length < this.limits.minBatchSize) break
            const plan = this.deps.plan(offered, balances, nonces)
            if (alone && plan.transfers.length === 0) {
                await this.deps.setRows([offered[0].txHash], L2PS_STATUS.DEFERRED)
                continue
            }
            if (plan.transfers.length === 0) {
                // None of these can be placed at this tip. Deferring them (again)
                // moves them behind the other deferred rows and out of the
                // fresh window.
                await this.deps.setRows(
                    candidates.map(t => t.txHash),
                    L2PS_STATUS.DEFERRED,
                )
                log.debug(
                    `[L2PS Settlement] ${l2psUid}: nothing settles this cycle (${candidates.length} deferred)`,
                )
                break
            }

            // Every account a transfer names, not only those the changes
            // list: an account left out could be planned again elsewhere.
            const accounts = new Set(plan.changes.map(c => c.account))
            for (const t of plan.transfers) {
                accounts.add(t.from)
                accounts.add(t.to)
            }
            for (const account of accounts) claimed.add(account)
            const bound = new Map<string, TipAccount>()
            for (const account of accounts) {
                const state = tip.get(account)
                if (state) bound.set(account, state)
            }
            batches.push({
                l2psUid,
                plan,
                rows: plan.transfers.map(t => rowOf.get(t.txHash)!),
                accounts,
                alone,
                bound,
            })

            const planned = new Set(plan.transfers.map(t => t.txHash))
            const settles = (t: DecryptedTransfer) =>
                !planned.has(t.txHash) && !accounts.has(t.from) && !accounts.has(t.to)
            candidates = candidates.filter(settles)
            suspects = suspects.filter(settles)
        }
        return batches
    }
}
