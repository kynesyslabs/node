/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

/**
 * DEM-665 — Gas fee distribution edit generator.
 *
 * Post-fork, the validating node calls these helpers from
 * `validateTransaction.confirmTransaction` (P6) and the TLSN-handling
 * branch of `handleNativeOperations` (P7) to convert per-component fee
 * totals into a sequence of {@link GCREditBalance} entries that:
 *
 *   1. Remove the total fee component from the sender's balance.
 *   2. Add the burned share to `feeDistribution.burnAddress`.
 *   3. Add the treasury share to `feeDistribution.treasuryAddress`.
 *   4. (rpc_fee / special_ops only) Add the rpc-operator share to the
 *      validating node's pubkey.
 *
 * Reads live data from `getSharedState.feeDistribution` (populated by
 * `loadForkConfigFromGenesis` for the burn/treasury addresses and by
 * `loadNetworkParameters` for the governance-driven percentage groups).
 * That object is null until both bootstraps run; callers MUST gate on
 * `isForkActive("gasFeeSeparation", blockHeight)` first AND on
 * `feeDistribution !== null` defensively.
 *
 * Rounding rule (consensus-critical): every per-component split is
 * `Math.floor(total * pct / 100)` for each non-treasury recipient; the
 * remainder is routed to treasury so the sum of edits is always exactly
 * the total. This must be deterministic across all validators — number
 * arithmetic is safe here because (a) post-fork totals are OS magnitudes
 * within the 2^53 safe range for any reasonable per-tx fee, and (b) the
 * SDK's GCREditBalance.amount type is `number | string` and accepts
 * `number` on the wire.
 */

import { GCREditBalance } from "@kynesyslabs/demosdk/types"
import { getSharedState } from "@/utilities/sharedState"
import log from "@/utilities/logger"

/**
 * Input bundle for {@link generateFeeDistributionEdits}.
 *
 * `senderAddress` and `rpcAddress` are lowercase 0x-prefixed ed25519 hex
 * pubkeys (66 chars total). `network_fee` / `rpc_fee` / `additional_fee`
 * are the per-component totals computed by
 * `calculateFeeBreakdown` (P4); a value of 0 short-circuits the entire
 * component's edit emission.
 *
 * `isRollback` is forwarded onto each emitted edit. Callers building a
 * rollback bundle pass `true` so the GCR-apply layer inverts the
 * add/remove direction when applying.
 */
export interface FeeDistributionInput {
    senderAddress: string
    rpcAddress: string | null
    networkFee: number
    rpcFee: number
    additionalFee: number
    txHash: string
    isRollback: boolean
}

/**
 * Lazy guard: returns the runtime `feeDistribution` view if both
 * bootstraps (P2's loader + P13's governance fold) have run, otherwise
 * logs and returns null. Callers receiving null MUST treat it as a
 * fork-not-yet-armed condition and emit no edits.
 */
function requireFeeDistribution(): NonNullable<
    typeof getSharedState.feeDistribution
> | null {
    const fd = getSharedState.feeDistribution
    if (!fd) {
        log.error(
            "[FeeDistribution] getSharedState.feeDistribution is null — fork is gated by isForkActive but the runtime view was never primed. Refusing to emit edits.",
        )
        return null
    }
    // PR #817 Greptile P2 — fail-closed when distribution percentages
    // are still in their pre-`loadNetworkParameters` zero state.
    //
    // `loadForkConfigFromGenesis` primes `feeDistribution` with zero
    // percentages so the structure is non-null before
    // `loadNetworkParameters` runs. If a post-fork tx is processed in
    // that window (race, partial-init test harness, etc.) every fee
    // would route 100% to treasury invisibly because all burn/rpc
    // shares are 0. Refusing to emit edits is louder than silently
    // misrouting fees — the caller surfaces the rejection through
    // `applyGasFeeSeparation`'s failure path which signs an invalid
    // ValidityData with a clear message.
    const allZero =
        fd.networkFee.burnPct === 0 &&
        fd.networkFee.treasuryPct === 0 &&
        fd.additionalFee.burnPct === 0 &&
        fd.additionalFee.treasuryPct === 0 &&
        fd.specialOps.burnPct === 0 &&
        fd.specialOps.rpcPct === 0 &&
        fd.specialOps.treasuryPct === 0
    if (allZero) {
        log.error(
            "[FeeDistribution] every distribution percentage is 0 — runtime view was primed by loadForkConfigFromGenesis but loadNetworkParameters has not yet folded governance values. Refusing to emit edits.",
        )
        return null
    }
    return fd
}

/**
 * Build a single GCREditBalance row. Centralised so the shape of the
 * edit (especially the `isRollback` / `txhash` plumbing) is wired in one
 * place.
 */
function makeBalanceEdit(
    operation: "add" | "remove",
    account: string,
    amount: number,
    txHash: string,
    isRollback: boolean,
): GCREditBalance {
    return {
        type: "balance",
        operation,
        isRollback,
        account,
        amount,
        txhash: txHash,
    }
}

/**
 * Emit the burn / treasury distribution edits for a two-recipient
 * component (network_fee or additional_fee). Returns an array of 0..3
 * edits: one `remove` from the sender plus up to two `add`s to burn and
 * treasury. Recipients with a 0% share contribute nothing.
 *
 * Treasury captures the rounding remainder so the sum of the
 * `add` amounts equals the `remove` amount exactly.
 */
function emitTwoRecipientSplit(
    componentName: "network_fee" | "additional_fee",
    total: number,
    burnPct: number,
    treasuryPct: number,
    burnAddress: string,
    treasuryAddress: string,
    senderAddress: string,
    txHash: string,
    isRollback: boolean,
): GCREditBalance[] {
    if (total <= 0) return []
    const edits: GCREditBalance[] = []
    const burnAmount = Math.floor((total * burnPct) / 100)
    const treasuryAmount = total - burnAmount // remainder to treasury

    edits.push(
        makeBalanceEdit(
            "remove",
            senderAddress,
            total,
            txHash,
            isRollback,
        ),
    )
    if (burnAmount > 0) {
        edits.push(
            makeBalanceEdit(
                "add",
                burnAddress,
                burnAmount,
                txHash,
                isRollback,
            ),
        )
    }
    if (treasuryAmount > 0) {
        edits.push(
            makeBalanceEdit(
                "add",
                treasuryAddress,
                treasuryAmount,
                txHash,
                isRollback,
            ),
        )
    }
    log.debug(
        `[FeeDistribution] ${componentName} split total=${total} burn=${burnAmount}(${burnPct}%) treasury=${treasuryAmount}(remainder of ${treasuryPct}%)`,
    )
    return edits
}

/**
 * Generate the GCREdit sequence for the full per-component fee
 * distribution of a regular transaction (post-fork).
 *
 * Order of emission:
 *   1. network_fee block — remove + burn add + treasury add
 *   2. rpc_fee block — remove + rpc-operator add (100%)
 *   3. additional_fee block — remove + burn add + treasury add
 *
 * Components with a 0 total are skipped entirely.
 *
 * If `feeDistribution` is null (bootstrap hasn't run) the function
 * returns an empty array and logs. Callers MUST guard on isForkActive
 * upstream — this function does not double-check the fork height
 * because it has no block-height context.
 *
 * If `rpcFee > 0` but `rpcAddress` is null, the rpc_fee block is
 * skipped with a warning. This should not happen in production
 * because P6 always sets `tx.content.transaction_fee.rpc_address`
 * before the call.
 */
export function generateFeeDistributionEdits(
    input: FeeDistributionInput,
): GCREditBalance[] {
    const fd = requireFeeDistribution()
    if (!fd) return []
    const {
        senderAddress,
        rpcAddress,
        networkFee,
        rpcFee,
        additionalFee,
        txHash,
        isRollback,
    } = input

    const edits: GCREditBalance[] = []

    // --- network_fee block ---
    edits.push(
        ...emitTwoRecipientSplit(
            "network_fee",
            networkFee,
            fd.networkFee.burnPct,
            fd.networkFee.treasuryPct,
            fd.burnAddress,
            fd.treasuryAddress,
            senderAddress,
            txHash,
            isRollback,
        ),
    )

    // --- rpc_fee block (100% to the validating rpc operator) ---
    //
    // PR #817 Greptile P1: when rpcAddress is unexpectedly null we
    // MUST NOT silently drop the whole block. Doing so leaves the
    // sender's rpc_fee tokens uncollected — a silent fee leak. The
    // sender's `remove` ALWAYS fires; the recipient `add` folds into
    // treasury when no rpc operator is identified, matching the
    // fallback behaviour `generateSpecialOpsFeeEdits` uses for the
    // same null-rpc case.
    if (rpcFee > 0) {
        edits.push(
            makeBalanceEdit(
                "remove",
                senderAddress,
                rpcFee,
                txHash,
                isRollback,
            ),
        )
        if (!rpcAddress) {
            log.warning(
                `[FeeDistribution] tx ${txHash} has rpcFee=${rpcFee} but no rpcAddress — folding rpc_fee into treasury.`,
            )
            edits.push(
                makeBalanceEdit(
                    "add",
                    fd.treasuryAddress,
                    rpcFee,
                    txHash,
                    isRollback,
                ),
            )
        } else {
            edits.push(
                makeBalanceEdit(
                    "add",
                    rpcAddress,
                    rpcFee,
                    txHash,
                    isRollback,
                ),
            )
        }
    }

    // --- additional_fee block ---
    edits.push(
        ...emitTwoRecipientSplit(
            "additional_fee",
            additionalFee,
            fd.additionalFee.burnPct,
            fd.additionalFee.treasuryPct,
            fd.burnAddress,
            fd.treasuryAddress,
            senderAddress,
            txHash,
            isRollback,
        ),
    )

    log.debug(
        `[FeeDistribution] tx ${txHash} → ${edits.length} edits ` +
            `(network=${networkFee}, rpc=${rpcFee}, additional=${additionalFee})`,
    )
    return edits
}

/**
 * Generate the GCREdit sequence for a TLSN special-operation total fee.
 *
 * Distribution rule (DEM-665 SPEC §1 / §8): a single component total is
 * split across three recipients per `feeDistribution.specialOps` — burn
 * %, rpc-operator %, treasury %. Rounding remainder goes to treasury so
 * the sum of `add` amounts equals the `remove` amount exactly.
 *
 * Returns 0..4 edits (1 remove + up to 3 adds). A zero total emits
 * nothing.
 */
export function generateSpecialOpsFeeEdits(
    senderAddress: string,
    rpcAddress: string | null,
    totalFee: number,
    txHash: string,
    isRollback: boolean,
): GCREditBalance[] {
    if (totalFee <= 0) return []
    const fd = requireFeeDistribution()
    if (!fd) return []
    const { specialOps } = fd

    const edits: GCREditBalance[] = []
    const burnAmount = Math.floor((totalFee * specialOps.burnPct) / 100)
    const rpcAmount = Math.floor((totalFee * specialOps.rpcPct) / 100)
    const treasuryAmount = totalFee - burnAmount - rpcAmount // remainder

    edits.push(
        makeBalanceEdit("remove", senderAddress, totalFee, txHash, isRollback),
    )
    if (burnAmount > 0) {
        edits.push(
            makeBalanceEdit(
                "add",
                fd.burnAddress,
                burnAmount,
                txHash,
                isRollback,
            ),
        )
    }
    if (rpcAmount > 0) {
        if (!rpcAddress) {
            log.warning(
                `[FeeDistribution] special-ops tx ${txHash} has rpcPct=${specialOps.rpcPct} but no rpcAddress — rpc share rolled into treasury.`,
            )
            // Fold the unrouted rpc share into treasury so the total
            // still balances.
            edits.push(
                makeBalanceEdit(
                    "add",
                    fd.treasuryAddress,
                    rpcAmount + treasuryAmount,
                    txHash,
                    isRollback,
                ),
            )
            return edits
        }
        edits.push(
            makeBalanceEdit(
                "add",
                rpcAddress,
                rpcAmount,
                txHash,
                isRollback,
            ),
        )
    }
    if (treasuryAmount > 0) {
        edits.push(
            makeBalanceEdit(
                "add",
                fd.treasuryAddress,
                treasuryAmount,
                txHash,
                isRollback,
            ),
        )
    }

    log.debug(
        `[FeeDistribution] special-ops tx ${txHash} total=${totalFee} → burn=${burnAmount} rpc=${rpcAmount} treasury=${treasuryAmount}`,
    )
    return edits
}
