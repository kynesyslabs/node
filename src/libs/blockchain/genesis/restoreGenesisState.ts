/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import type { EntityManager } from "typeorm"

import { identityCarryoverActiveAtGenesis } from "@/forks/identityCarryoverGate"
import { assertCarryoverSnapshot } from "./carryover"
import { GenesisRefusal } from "./genesisPin"
import type { SnapshotLoader } from "./loadSnapshot"
import { restoreSnapshot } from "./restoreSnapshot"
import { mergeGenesisBalances } from "./mergeGenesisBalances"
import { applyForksAtGenesis } from "./applyForksAtGenesis"
import { seedValidators, type GenesisValidatorSeed } from "./seedValidators"

export type GenesisStateSteps = {
    assertCarryover: typeof assertCarryoverSnapshot
    restore: typeof restoreSnapshot
    mergeBalances: typeof mergeGenesisBalances
    applyForks: typeof applyForksAtGenesis
    seedValidators: typeof seedValidators
}

const STEPS: GenesisStateSteps = {
    assertCarryover: assertCarryoverSnapshot,
    restore: restoreSnapshot,
    mergeBalances: mergeGenesisBalances,
    applyForks: applyForksAtGenesis,
    seedValidators,
}

/**
 * Writes block 0's account state from the snapshot, all in one transaction
 * so a failure leaves the database empty. Returns false when there is no
 * snapshot and the caller takes the legacy genesisData.balances path.
 *
 * Under identityCarryover the snapshot is checked in full before the
 * transaction opens, and a missing snapshot is refused: the legacy path
 * would build a chain without the user data the genesis promises.
 */
export async function restoreGenesisState(
    transaction: <T>(work: (em: EntityManager) => Promise<T>) => Promise<T>,
    snapshot: SnapshotLoader,
    genesisData: {
        balances?: unknown
        forks?: unknown
        validators?: unknown
    },
    steps: GenesisStateSteps = STEPS,
): Promise<boolean> {
    const carryover = identityCarryoverActiveAtGenesis()
    if (!snapshot.available) {
        if (carryover) {
            throw new GenesisRefusal(
                "identityCarryover is active at genesis but no snapshot was found " +
                    "(data/snapshot, or DEMOS_SNAPSHOT_DIR)",
            )
        }
        return false
    }

    const snapshotHasValidators =
        snapshot.manifest.files["validators.jsonl"] !== undefined
    if (carryover) {
        await steps.assertCarryover(snapshot, genesisData.validators)
    }
    await transaction(async em => {
        await steps.restore(em, snapshot, { carryover })
        // Operator-written allocations replace the snapshot balance of their
        // account; block 0 already commits to them through extra.genesisData.
        await steps.mergeBalances(em, genesisData.balances)
        // The manifest's fork_state names the forks already baked into the
        // snapshot data; the rest run here, deterministically.
        await steps.applyForks(
            em,
            genesisData.forks as Parameters<typeof applyForksAtGenesis>[1],
            snapshot.manifest.fork_state,
        )
        // The snapshot's validators.jsonl owns the set when it has one.
        if (
            !snapshotHasValidators &&
            Array.isArray(genesisData.validators) &&
            genesisData.validators.length > 0
        ) {
            await steps.seedValidators(
                em,
                genesisData.validators as GenesisValidatorSeed[],
            )
        }
    })
    return true
}
