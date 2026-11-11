/**
 * The entry node's half of L2PS settlement: turns executed L2PS transfers into
 * proven `l2psBatch` settlement records and follows each batch until it lands.
 * Spec: docs/design/l2ps-zk-settlement.md, "Interface v1".
 *
 * Rules this keeps:
 * - A batch is planned on balances and nonces read at the tip, so no account
 *   a batch in flight touches is planned again until that batch has landed or
 *   failed; otherwise the second proof would bind stale balances.
 * - A transfer that cannot go into this batch (overdraft, nonce gap, slots)
 *   stays queued; one whose nonce L1 has already spent, or whose signed fee is
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
 *   a tip that moved, a shutdown) are never counted.
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
    | { ok: false; permanent: boolean; reason: string }

/** Everything the settlement loop touches outside itself, injectable for tests. */
export interface SettlementDeps {
    /** Subnets with rows in `status`. */
    subnets(status: L2PSStatus): Promise<string[]>
    /** Rows in queue order from `offset`; throws when the read fails, so a failed read is never an empty queue. */
    rows(l2psUid: string, status: L2PSStatus, limit: number, offset?: number): Promise<L2PSMempoolTx[]>
    /** Decrypts a queued row and opens its settlement transfer. Throws when the subnet cannot decrypt at all. */
    open(l2psUid: string, row: L2PSMempoolTx): Promise<TransferVerdict>
    tip(accounts: Iterable<string>): Promise<Map<string, TipAccount>>
    /** The native transfer fee now, in OS: the floor block apply holds each transfer's fee to. */
    minimumFee(): Promise<bigint>
    plan(
        transfers: DecryptedTransfer[],
        balances: Map<string, bigint>,
        nonces: Map<string, bigint>,
    ): SettlementPlan
    prove(plan: SettlementPlan): Promise<SettlementProofResult>
    /** Submits the batch to the mempool. */
    submit(l2psUid: string, record: SettlementRecord, rows: L2PSMempoolTx[]): Promise<SubmitResult>
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
    /** Balances and nonces of its accounts it was planned on; unknown after a restart. */
    bound?: Map<string, TipAccount>
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
        ].sort()
        const first = subnets.length > 0 ? this.cycles % subnets.length : 0
        this.cycles++
        const order = [...subnets.slice(first), ...subnets.slice(0, first)]

        // A proof binds the tip balances of its accounts, so no two batches
        // waiting to land may share one, whichever subnet planned them.
        const claimed = this.lockedAccounts()
        const slots = Math.max(1, Math.floor(this.limits.provers))
        const planned: PlannedBatch[] = []
        for (const l2psUid of order) {
            if (planned.length >= slots) break
            if (this.deps.now() < (this.proverPause.get(l2psUid)?.until ?? 0)) continue
            planned.push(...(await this.planSubnet(l2psUid, claimed, slots - planned.length)))
        }
        if (this.closed) return { submitted: 0, transfers: 0 }

        const tally: CycleTally = { submitted: 0, transfers: 0, failed: new Set(), worked: new Set() }
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

        let sent: SubmitResult
        try {
            sent = await this.deps.submit(l2psUid, settlementRecord(plan, outcome.proof), batch.rows)
        } catch (error) {
            sent = { ok: false, permanent: false, reason: getErrorMessage(error) }
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

        // Followed from here on whatever the row writes below do: the mempool
        // holds the batch, so its accounts stay locked until it lands or fails.
        const rowHashes = batch.rows.map(row => row.hash)
        this.inFlight.set(l1TxHash, {
            l2psUid,
            l1TxHash,
            rowHashes,
            accounts: batch.accounts,
            submittedAt: this.deps.head(),
            alone: batch.alone,
            bound: batch.bound,
        })
        log.info(
            `[L2PS Settlement] Submitted batch ${l1TxHash.slice(0, 16)}... for ${l2psUid}: ${plan.transfers.length} transfers, ${plan.changes.length} accounts`,
        )
        try {
            await this.deps.setRows(rowHashes, L2PS_STATUS.BATCHED)
            for (const hash of rowHashes) {
                await this.deps.history(hash, "batched", "Included in an L1 settlement batch", l1TxHash)
            }
        } catch (error) {
            log.error(
                `[L2PS Settlement] Batch ${l1TxHash.slice(0, 16)}... is submitted but its rows could not be marked batched; it is followed until it lands: ${getErrorMessage(error)}`,
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
            if (batch.landedAt !== undefined) {
                if (head > batch.landedAt) this.inFlight.delete(batch.l1TxHash)
                continue
            }
            let status: TxStatus
            try {
                status = await this.deps.status(batch.l1TxHash)
            } catch (error) {
                log.warning(
                    `[L2PS Settlement] Could not read the status of batch ${batch.l1TxHash.slice(0, 16)}...: ${getErrorMessage(error)}`,
                )
                continue
            }
            if (status.state === "included") {
                await this.deps.setRows(batch.rowHashes, L2PS_STATUS.CONFIRMED)
                for (const hash of batch.rowHashes) {
                    await this.deps.history(
                        hash,
                        "confirmed",
                        `Settled on L1 in block ${status.blockNumber}`,
                        batch.l1TxHash,
                        status.blockNumber,
                    )
                }
                this.batchesLanded++
                for (const hash of batch.rowHashes) this.blame.delete(hash)
                batch.landedAt = status.blockNumber ?? head
                if (head > batch.landedAt) this.inFlight.delete(batch.l1TxHash)
                log.info(
                    `[L2PS Settlement] Batch ${batch.l1TxHash.slice(0, 16)}... settled ${batch.rowHashes.length} transfers for ${batch.l2psUid} in block ${status.blockNumber}`,
                )
                continue
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
                if (
                    status.state === "failed" &&
                    !NOT_THE_TRANSFERS.has(status.code ?? "") &&
                    !(await this.tipMoved(batch))
                ) {
                    await this.blameFailure(batch.rowHashes, batch.alone, "l1")
                }
                log.warning(
                    `[L2PS Settlement] Batch ${batch.l1TxHash.slice(0, 16)}... for ${batch.l2psUid}: ${why}${status.message ? ` (${status.message})` : ""}`,
                )
            }
        }
    }

    /**
     * Whether a failed batch's accounts are no longer at the balances and
     * nonces it was proved on. A failed settlement edits none of them, so a
     * change came from another transaction and the proof was stale, through
     * no fault of the transfers. Unknown counts as moved.
     */
    private async tipMoved(batch: InFlightBatch): Promise<boolean> {
        if (!batch.bound) return true
        let now: Map<string, TipAccount>
        try {
            now = await this.deps.tip(batch.bound.keys())
        } catch (error) {
            log.warning(
                `[L2PS Settlement] Could not read the tip for failed batch ${batch.l1TxHash.slice(0, 16)}...: ${getErrorMessage(error)}`,
            )
            return true
        }
        for (const [account, was] of batch.bound) {
            const is = now.get(account)
            if (!is || is.balance !== was.balance || is.nonce !== was.nonce) return true
        }
        return false
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
                this.blame.delete(hash)
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
        this.blame.delete(row.hash)
        await this.deps.setRows([row.hash], L2PS_STATUS.FAILED)
        await this.deps.history(row.hash, "failed", reason)
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
        const rows = [...fresh, ...parked]
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

        const tip = await this.deps.tip(opened.flatMap(t => [t.from, t.to]))
        const minimumFee = await this.deps.minimumFee()
        const live: DecryptedTransfer[] = []
        for (const transfer of opened) {
            const accountNonce = tip.get(transfer.from)?.nonce ?? 0n
            if (transfer.nonce <= accountNonce) {
                await this.drop(
                    rowOf.get(transfer.txHash)!,
                    `nonce ${transfer.nonce} already spent on L1 (account nonce ${accountNonce})`,
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
