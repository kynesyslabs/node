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
import { isAllowlistedMint, isNftGatingEnabled } from "src/features/staking/nftAllowlist"
import { getMinValidatorStake } from "src/features/staking/minStake"

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
            case "evict":
                return applyEvict(resolvedRepo, existing)
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
    if (op === "evict") return "stake"
    return op
}

/** Whether a row still holds its NFT's seat. */
function holdsSeat(row: Validators | null): boolean {
    return (
        row !== null &&
        (row.status === VALIDATOR_STATUS_ACTIVE ||
            row.status === VALIDATOR_STATUS_UNSTAKING)
    )
}

/**
 * The NFT rules every node applies when a stake takes a seat: a proof is
 * recorded and its mint is allowlisted. Another seat backed by the same
 * mint, including one staged earlier in the same block, is evicted: the
 * proof was signed by the wallet that holds the NFT now, which is the
 * authority over the seat.
 */
async function takeSeatNft(
    repo: Repository<Validators>,
    account: string,
    edit: GCREditValidatorStake,
): Promise<GCRResult | null> {
    if (!isNftGatingEnabled()) return null
    const nft = edit.nft
    if (!nft || !nft.mint || !nft.owner || !nft.proofTx) {
        return { success: false, message: "Validator entrance requires an NFT proof" }
    }
    if (!isAllowlistedMint(nft.mint)) {
        return { success: false, message: `NFT ${nft.mint} is not eligible` }
    }
    const holders = await repo.findBy({ nft_mint: nft.mint })
    for (const other of holders) {
        if (!holdsSeat(other) || other.address === account) continue
        closeSeat(other)
        await repo.save(other)
        log.info(
            "VALIDATORS",
            `[evict] ${other.address} evicted: NFT ${nft.mint} rebound to ${account}`,
        )
    }
    return null
}

function closeSeat(row: Validators): void {
    row.status = VALIDATOR_STATUS_EXITED
    row.staked_amount = "0"
    row.unstake_requested_at = null
    row.unstake_available_at = null
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

    const entering = !existing || existing.status === VALIDATOR_STATUS_EXITED
    if (entering && !edit.isRollback) {
        const min = getMinValidatorStake()
        if (amount < min) {
            return {
                success: false,
                message: `Initial stake ${amount} below minimum ${min}`,
            }
        }
        const refused = await takeSeatNft(repo, account, edit)
        if (refused) return refused
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
            nft_mint: edit.nft?.mint ?? null,
            nft_owner: edit.nft?.owner ?? null,
            nft_proof_tx: edit.nft?.proofTx ?? null,
        })
        await repo.save(row)
        log.info(
            "VALIDATORS",
            `[stake] ${account} entered as validator with ${amount}`,
        )
        return { success: true, message: "Validator entered" }
    }

    if (entering && edit.nft) {
        // Re-entry after an exit takes the seat with the new proof.
        existing.nft_mint = edit.nft.mint
        existing.nft_owner = edit.nft.owner
        existing.nft_proof_tx = edit.nft.proofTx
        existing.valid_at = currentBlock
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
        if (existing.status !== VALIDATOR_STATUS_UNSTAKING) {
            return {
                success: false,
                message: `Cannot exit — must be UNSTAKING (status=${existing.status})`,
            }
        }
        if (
            existing.unstake_available_at === null ||
            existing.unstake_available_at === undefined ||
            currentBlock < existing.unstake_available_at
        ) {
            return {
                success: false,
                message: `Lock not elapsed: ${currentBlock} < ${existing.unstake_available_at}`,
            }
        }
    }
    existing.status = VALIDATOR_STATUS_EXITED
    existing.staked_amount = "0"
    await repo.save(existing)
    log.info("VALIDATORS", `[exit] ${existing.address} exited`)
    return { success: true, message: "Validator exited" }
}

/** A challenge proved the NFT left its wallet: the seat is closed at once. */
async function applyEvict(
    repo: Repository<Validators>,
    existing: Validators | null,
): Promise<GCRResult> {
    if (!existing) {
        return { success: false, message: "Validator not found" }
    }
    if (!holdsSeat(existing)) {
        return {
            success: false,
            message: `Cannot evict — holds no seat (status=${existing.status})`,
        }
    }
    closeSeat(existing)
    await repo.save(existing)
    log.info("VALIDATORS", `[evict] ${existing.address} evicted`)
    return { success: true, message: "Validator evicted" }
}
