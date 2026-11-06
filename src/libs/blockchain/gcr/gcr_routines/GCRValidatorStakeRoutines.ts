import type { GCREdit } from "@kynesyslabs/demosdk/types"
import type { GCREditValidatorStake } from "src/features/staking/types"
import { Repository } from "typeorm"
import Datasource from "@/model/datasource"
import { Validators } from "@/model/entities/Validators"
import Chain from "@/libs/blockchain/chain"
import { canonicalAddress } from "@/libs/network/utils/txHelpers"
import type { GCRResult } from "src/libs/blockchain/gcr/handleGCR"
import log from "src/utilities/logger"
import {
    UNSTAKE_LOCK_BLOCKS,
    VALIDATOR_STATUS_ACTIVE,
    VALIDATOR_STATUS_EXITED,
    VALIDATOR_STATUS_UNSTAKING,
} from "src/features/staking/constants"
import type { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { isForkActive } from "@/forks"
import { quorumThreshold } from "src/libs/consensus/v2/quorum"
import { getSharedState } from "src/utilities/sharedState"
import { chainMinValidatorStake } from "src/features/staking/chainMinStake"

/** What a block's apply knows beyond the validator row. */
export interface StakeApplyContext {
    /** The account the edit names, as the block's caches hold it. */
    account?: GCRMain | null
    /** Validator rows the block already staged, by address. */
    stagedRows?: Map<string, Validators | null>
    /**
     * Whether the caller is reversing this edit. The edit's own flag came
     * with the transaction, so the sender could set it.
     */
    rollback?: boolean
}

/**
 * Applies a GCREditValidatorStake against the Validators table.
 *
 * Unlike balance/nonce/identity edits (which mutate a GCRMain row and are
 * batched through `applyTransaction`), validator state lives in its own
 * table and is small enough that we save each edit eagerly.
 */
export default class GCRValidatorStakeRoutines {
    /**
     * Applies a GCREditValidatorStake edit.
     *
     * `repo` and `currentBlock` are injected by callers with a batching
     * context (handleGCR holds a repositories bag and already knows the
     * block); unit tests pass fakes. When omitted we resolve both from the
     * live datasource / chain — this is the default at runtime.
     */
    static async apply(
        edit: GCREdit,
        repo?: Repository<Validators>,
        currentBlock?: number,
        context: StakeApplyContext = {},
    ): Promise<GCRResult> {
        // The SDK's GCREdit union does not yet include validatorStake (it
        // will be added in SDK Batch 1). We reach this routine only via the
        // dispatch in handleGCR's switch, so the cast is safe.
        const stakeEdit = edit as unknown as GCREditValidatorStake
        if (stakeEdit.type !== "validatorStake") {
            return { success: false, message: "Invalid GCREdit type" }
        }
        // Canonicalise to lowercase at the persistence boundary: validator
        // rows live keyed by `address` and governance comparisons use the
        // lower-case form of the sender. Storing mixed-case here would
        // re-introduce the G-1/G-4 lookup mismatch.
        const account = canonicalAddress(
            typeof stakeEdit.account === "string"
                ? stakeEdit.account
                : Buffer.from(
                      stakeEdit.account as unknown as Uint8Array,
                  ).toString("hex"),
        )

        const operation = stakeEdit.isRollback
            ? invertOperation(stakeEdit.operation)
            : stakeEdit.operation

        const resolvedRepo =
            repo ??
            (await Datasource.getInstance())
                .getDataSource()
                .getRepository(Validators)
        const resolvedBlock =
            currentBlock ?? (await Chain.getLastBlockNumber())

        const existing = await resolvedRepo.findOneBy({ address: account })

        if (isForkActive("stakeApplyChecks", resolvedBlock)) {
            return applyChecked(
                resolvedRepo,
                existing,
                account,
                stakeEdit,
                resolvedBlock,
                context,
            )
        }

        switch (operation) {
            case "stake":
                return applyStake(
                    resolvedRepo,
                    existing,
                    account,
                    stakeEdit,
                    resolvedBlock,
                )
            case "unstake":
                return applyUnstake(resolvedRepo, existing, resolvedBlock)
            case "exit":
                return applyExit(
                    resolvedRepo,
                    existing,
                    resolvedBlock,
                    stakeEdit.isRollback === true,
                )
            default:
                return { success: false, message: `Unknown op: ${operation}` }
        }
    }
}

function invertOperation(
    op: GCREditValidatorStake["operation"],
): GCREditValidatorStake["operation"] {
    // Rollback semantics for validator state are inherently lossy (we can
    // reverse the delta but not reconstruct the exact prior state). For
    // Phase 0 the chain does not trigger validator-edit rollbacks outside
    // of failed simulation, so logging is sufficient. We still invert stake
    // ↔ exit so re-applying the same edit is idempotent.
    if (op === "stake") return "exit"
    if (op === "exit") return "stake"
    return op
}

async function applyStake(
    repo: Repository<Validators>,
    existing: Validators | null,
    account: string,
    edit: GCREditValidatorStake,
    currentBlock: number,
): Promise<GCRResult> {
    let amount: bigint
    try {
        amount = BigInt(edit.amount)
    } catch {
        return { success: false, message: "Invalid stake amount" }
    }
    if (amount <= 0n) {
        return { success: false, message: "Stake must be positive" }
    }

    if (!existing) {
        const row = repo.create({
            address: account,
            status: VALIDATOR_STATUS_ACTIVE,
            connection_url: edit.connectionUrl ?? null,
            staked_amount: amount.toString(),
            first_seen: currentBlock,
            valid_at: currentBlock,
            unstake_requested_at: null,
            unstake_available_at: null,
        })
        await repo.save(row)
        log.info(
            "VALIDATORS",
            `[stake] ${account} entered as validator with ${amount}`,
        )
        return { success: true, message: "Validator entered" }
    }

    let prev: bigint
    try {
        prev = BigInt(existing.staked_amount ?? "0")
    } catch {
        return {
            success: false,
            message: `Invalid persisted staked_amount=${existing.staked_amount}`,
        }
    }
    existing.staked_amount = (prev + amount).toString()
    if (edit.connectionUrl) {
        existing.connection_url = edit.connectionUrl
    }
    // A new stake re-activates the validator and clears any pending
    // unstake. Letting UNSTAKING persist would let an attacker top up,
    // then exit using the old (already-elapsed) lock window.
    existing.status = VALIDATOR_STATUS_ACTIVE
    existing.unstake_requested_at = null
    existing.unstake_available_at = null
    await repo.save(existing)
    log.info(
        "VALIDATORS",
        `[stake] ${account} increased stake by ${amount} (new total=${existing.staked_amount})`,
    )
    return { success: true, message: "Stake increased" }
}

async function applyUnstake(
    repo: Repository<Validators>,
    existing: Validators | null,
    currentBlock: number,
): Promise<GCRResult> {
    if (!existing) {
        return { success: false, message: "Validator not found" }
    }
    existing.unstake_requested_at = currentBlock
    existing.unstake_available_at = currentBlock + UNSTAKE_LOCK_BLOCKS
    existing.status = VALIDATOR_STATUS_UNSTAKING
    await repo.save(existing)
    log.info(
        "VALIDATORS",
        `[unstake] ${existing.address} requested unstake at block ${currentBlock}; available at ${existing.unstake_available_at}`,
    )
    return { success: true, message: "Unstake requested" }
}

/** Why `existing` cannot exit at `currentBlock`, or null. */
function exitRefusal(existing: Validators, currentBlock: number): string | null {
    if (existing.status !== VALIDATOR_STATUS_UNSTAKING) {
        return `Cannot exit — must be UNSTAKING (status=${existing.status})`
    }
    if (
        existing.unstake_available_at === null ||
        existing.unstake_available_at === undefined ||
        currentBlock < existing.unstake_available_at
    ) {
        return `Lock not elapsed: ${currentBlock} < ${existing.unstake_available_at}`
    }
    return null
}

async function applyExit(
    repo: Repository<Validators>,
    existing: Validators | null,
    currentBlock: number,
    isRollback: boolean,
): Promise<GCRResult> {
    if (!existing) {
        return { success: false, message: "Validator not found" }
    }
    // Lifecycle invariants only apply to user-initiated exits. Rollback
    // path (stake → exit inversion) bypasses them by design.
    if (!isRollback) {
        const refusal = exitRefusal(existing, currentBlock)
        if (refusal) return { success: false, message: refusal }
    }
    existing.status = VALIDATOR_STATUS_EXITED
    existing.staked_amount = "0"
    await repo.save(existing)
    log.info("VALIDATORS", `[exit] ${existing.address} exited`)
    return { success: true, message: "Validator exited" }
}

/**
 * The `stakeApplyChecks` rules. Every node applies them to every block, so a
 * stake that skipped the RPC checks of the node that took it in is held to
 * the same rules.
 */
async function applyChecked(
    repo: Repository<Validators>,
    existing: Validators | null,
    address: string,
    edit: GCREditValidatorStake,
    currentBlock: number,
    context: StakeApplyContext,
): Promise<GCRResult> {
    const rollback = context.rollback === true
    switch (edit.operation) {
        case "stake":
            return rollback
                ? undoBondedStake(repo, existing, edit, context.account)
                : bondStake(repo, existing, address, edit, currentBlock, context.account)
        case "unstake":
            return rollback
                ? undoUnstake(repo, existing)
                : guardedUnstake(repo, existing, currentBlock, context.stagedRows)
        case "exit":
            // The edit does not carry what the exit paid out, so it cannot
            // be reversed; a failed transaction restores the rows instead.
            return rollback
                ? { success: false, message: "An exit cannot be rolled back" }
                : refundingExit(repo, existing, currentBlock, context.account)
        default:
            return { success: false, message: `Unknown op: ${edit.operation}` }
    }
}

function parseAmount(value: unknown): bigint | null {
    try {
        return BigInt(value as string)
    } catch {
        return null
    }
}

async function bondStake(
    repo: Repository<Validators>,
    existing: Validators | null,
    address: string,
    edit: GCREditValidatorStake,
    currentBlock: number,
    account: GCRMain | null | undefined,
): Promise<GCRResult> {
    const amount = parseAmount(edit.amount)
    if (amount === null) return { success: false, message: "Invalid stake amount" }
    if (amount <= 0n) return { success: false, message: "Stake must be positive" }
    if (!account) return { success: false, message: "Missing account for stake" }

    const balance = BigInt(account.balance)
    if (balance < amount) {
        return {
            success: false,
            message: `Insufficient balance for stake: ${amount} exceeds balance ${balance}`,
        }
    }

    // An exited row holds no stake, so coming back is entering again.
    const entering =
        !existing ||
        (existing.status !== VALIDATOR_STATUS_ACTIVE &&
            existing.status !== VALIDATOR_STATUS_UNSTAKING)
    if (entering) {
        const min = chainMinValidatorStake()
        if (amount < min) {
            return {
                success: false,
                message: `Stake ${amount} below minimum ${min} to enter the validator set`,
            }
        }
        if (!edit.connectionUrl && !existing?.connection_url) {
            return {
                success: false,
                message: "connectionUrl required to enter the validator set",
            }
        }
    }

    const prevStake = parseAmount(existing?.staked_amount ?? "0")
    const prevBond = parseAmount(existing?.bonded_amount ?? "0")
    if (prevStake === null || prevBond === null) {
        return {
            success: false,
            message: `Invalid persisted stake for ${address}`,
        }
    }

    const row =
        existing ??
        repo.create({
            address,
            first_seen: currentBlock,
            valid_at: currentBlock,
        })
    row.staked_amount = (prevStake + amount).toString()
    row.bonded_amount = (prevBond + amount).toString()
    if (edit.connectionUrl) {
        row.connection_url = edit.connectionUrl
    }
    // A new stake re-activates the validator and clears any pending
    // unstake, so a top-up cannot exit on an already elapsed lock window.
    row.status = VALIDATOR_STATUS_ACTIVE
    row.unstake_requested_at = null
    row.unstake_available_at = null
    await repo.save(row)
    account.balance = balance - amount
    log.info(
        "VALIDATORS",
        `[stake] ${address} bonded ${amount} (total=${row.staked_amount})`,
    )
    return {
        success: true,
        message: existing ? "Stake increased" : "Validator entered",
    }
}

/**
 * Reverses one stake: its amount comes off the row and goes back to the
 * balance. A row left with no stake reads as exited.
 */
async function undoBondedStake(
    repo: Repository<Validators>,
    existing: Validators | null,
    edit: GCREditValidatorStake,
    account: GCRMain | null | undefined,
): Promise<GCRResult> {
    if (!existing) return { success: false, message: "Validator not found" }
    if (!account) return { success: false, message: "Missing account for stake" }
    const amount = parseAmount(edit.amount)
    const prevStake = parseAmount(existing.staked_amount ?? "0")
    const prevBond = parseAmount(existing.bonded_amount ?? "0")
    if (
        amount === null ||
        amount <= 0n ||
        prevStake === null ||
        prevBond === null ||
        prevStake < amount ||
        prevBond < amount
    ) {
        return { success: false, message: "Stake to roll back is not on the row" }
    }
    existing.staked_amount = (prevStake - amount).toString()
    existing.bonded_amount = (prevBond - amount).toString()
    if (prevStake === amount) {
        existing.status = VALIDATOR_STATUS_EXITED
    }
    await repo.save(existing)
    account.balance = BigInt(account.balance) + amount
    return { success: true, message: "Stake rolled back" }
}

/** Validators active once the rows this block staged are taken into account. */
async function countActive(
    repo: Repository<Validators>,
    stagedRows: Map<string, Validators | null> | undefined,
): Promise<number> {
    const rows = await repo.find({
        where: { status: VALIDATOR_STATUS_ACTIVE },
    })
    const active = new Set<string>()
    for (const row of rows) {
        if (row.address) active.add(row.address)
    }
    for (const [address, row] of stagedRows ?? []) {
        if (row?.status === VALIDATOR_STATUS_ACTIVE) active.add(address)
        else active.delete(address)
    }
    return active.size
}

async function guardedUnstake(
    repo: Repository<Validators>,
    existing: Validators | null,
    currentBlock: number,
    stagedRows: Map<string, Validators | null> | undefined,
): Promise<GCRResult> {
    if (!existing) return { success: false, message: "Validator not found" }
    if (existing.status !== VALIDATOR_STATUS_ACTIVE) {
        return {
            success: false,
            message: `Validator not active (status=${existing.status})`,
        }
    }
    if (
        existing.unstake_requested_at !== null &&
        existing.unstake_requested_at !== undefined
    ) {
        return { success: false, message: "Unstake already requested" }
    }
    // An unstaking validator leaves the pool at once, and below the floor
    // no committee forms: the chain would halt with no way to stake back in.
    const floor = quorumThreshold(getSharedState.shardSize)
    const remaining = (await countActive(repo, stagedRows)) - 1
    if (remaining < floor) {
        return {
            success: false,
            message: `Unstake would leave ${remaining} active validators, below the committee floor of ${floor}`,
        }
    }
    return applyUnstake(repo, existing, currentBlock)
}

async function undoUnstake(
    repo: Repository<Validators>,
    existing: Validators | null,
): Promise<GCRResult> {
    if (!existing || existing.status !== VALIDATOR_STATUS_UNSTAKING) {
        return { success: false, message: "No unstake to roll back" }
    }
    existing.status = VALIDATOR_STATUS_ACTIVE
    existing.unstake_requested_at = null
    existing.unstake_available_at = null
    await repo.save(existing)
    return { success: true, message: "Unstake rolled back" }
}

async function refundingExit(
    repo: Repository<Validators>,
    existing: Validators | null,
    currentBlock: number,
    account: GCRMain | null | undefined,
): Promise<GCRResult> {
    if (!existing) return { success: false, message: "Validator not found" }
    if (!account) return { success: false, message: "Missing account for exit" }
    const bond = parseAmount(existing.bonded_amount ?? "0")
    if (bond === null || bond < 0n) {
        return {
            success: false,
            message: `Invalid persisted bonded_amount=${existing.bonded_amount}`,
        }
    }
    const refusal = exitRefusal(existing, currentBlock)
    if (refusal) return { success: false, message: refusal }
    // The row keeps no stake after exit, so a later exit has nothing to pay.
    existing.status = VALIDATOR_STATUS_EXITED
    existing.staked_amount = "0"
    existing.bonded_amount = "0"
    await repo.save(existing)
    account.balance = BigInt(account.balance) + bond
    log.info("VALIDATORS", `[exit] ${existing.address} exited, refunded ${bond}`)
    return { success: true, message: "Validator exited" }
}
