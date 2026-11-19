import log from "src/utilities/logger"
import Block from "./block"
import HandleGCR from "./gcr/handleGCR"
import getCommonValidatorSeed from "../consensus/v2/routines/getCommonValidatorSeed"
import { insertBlock } from "./chainBlocks"
import Datasource from "src/model/datasource"
import { loadSnapshot } from "src/libs/blockchain/genesis/loadSnapshot"
import { restoreGenesisState } from "src/libs/blockchain/genesis/restoreGenesisState"
import { buildGenesisBlock } from "src/libs/blockchain/genesis/buildGenesisBlock"
import { markStorageProgramsDirty } from "./finality/storageRoot"
import { withBlockTime } from "./gcr/applyTime"

/**
 * `checkHash` sees block 0's hash before anything is written and may throw to
 * stop the boot with the database left empty.
 */
export async function generateGenesisBlock(
    genesisData: any,
    checkHash?: (hash: string) => void,
): Promise<Block> {
    const { genesisBlock, genesisTx } = buildGenesisBlock(genesisData)
    checkHash?.(genesisBlock.hash)

    const { commonValidatorSeed } = await getCommonValidatorSeed(
        genesisBlock as any,
    )
    genesisBlock.next_proposer = commonValidatorSeed
    // log.debug("[GENESIS] Block generated, ready to insert it")
    // log.debug("[GENESIS] inserting transaction into the mempool")
    // await Mempool.addTransaction({ ...genesisTx, reference_block: 0 }, 0)
    // log.debug("[GENESIS] inserted transaction")

    // SECTION: Restoring account data
    //
    // Two paths, gated by snapshot availability:
    //
    //   1. Snapshot present (P1 — fresh hard-fork chain bootstrap):
    //      stream rows from `data/snapshot/*.jsonl` into gcr_main +
    //      gcr_storageprogram + identity_commitments under a single
    //      caller-owned transaction. The legacy `genesisData.balances` /
    //      `genesisData.users` arrays are SKIPPED — the snapshot owns
    //      every account row, including the founder pubkeys that used to
    //      ride in `balances`. See forking/restore/PLAN.md P1 + P3.
    //
    //   2. No snapshot (dev / empty-chain boot): fall through to the
    //      pre-snapshot behavior — derive `users{}` from
    //      `genesisData.balances` and overlay `genesisData.users`, then
    //      seed via HandleGCR.createAccount in batches. Back-compat for
    //      operators who don't ship a snapshot.
    //
    // Ordering note: this restore block sits between the mempool add and
    // `insertBlock(...)`. `insertBlock` opens its own internal transaction
    // (with Merkle-tree updates, governance hooks, and savepoint-per-tx
    // logic) so it cannot easily be folded into the snapshot transaction
    // without invasive refactoring.
    //
    // Risk: if `insertBlock` fails AFTER the snapshot transaction commits,
    // the DB carries gcr_main/gcr_storageprogram rows but no block 0.
    // Mitigation (approach b): `restoreSnapshot.preflightEmpty` detects this
    // "partial genesis" state on the next boot (gcr_main populated, blocks
    // empty) and emits a specific operator-facing error distinguishing it
    // from "fully initialised chain". The operator recovers by wiping via
    // `./run -b true`. Full atomicity (approach a) would require plumbing an
    // optional EntityManager through insertBlock — deferred to a future refactor.
    // Every node seeds block 0's accounts itself, so the rows carry block
    // 0's time, not the clock of the node that seeds them.
    await withBlockTime(genesisBlock.content.timestamp, () =>
        seedGenesisAccounts(genesisData),
    )

    await insertBlock(genesisBlock, [genesisTx], 0)
    return genesisBlock
}

async function seedGenesisAccounts(genesisData: any): Promise<void> {
    const snapshot = await loadSnapshot()

    // The restore writes gcr_storageprogram; a rolled-back restore changes
    // nothing, so only a commit needs the second mark.
    if (snapshot.available) markStorageProgramsDirty()
    const db = await Datasource.getInstance()
    const dataSource = db.getDataSource()
    const restored = await restoreGenesisState(
        work => dataSource.transaction(work),
        snapshot,
        genesisData,
    )
    if (restored) {
        markStorageProgramsDirty()
    } else {
        log.info(
            "[GENESIS] no snapshot at data/snapshot/; falling back to genesisData.balances + genesisData.users",
        )
        // NOTE: genesis-baked validators are intentionally NOT seeded in the
        // legacy path. The founding validator set is tied to the snapshot-fork-
        // bootstrap flow. Dev/empty-chain operators register validators via the
        // existing staking flow (bun upgradable:cli / scripts/upgradable-network/cli.ts).

        const users: Record<string, Record<string, any>> = {}

        for (const balance of genesisData.balances) {
            const user = {
                pubkey: balance[0],
                balance: balance[1],
            }
            users[user.pubkey] = user
        }

        for (const user of genesisData?.users || []) {
            const balance = users[user.pubkey]?.balance || 0n
            users[user.pubkey] = {
                ...user,
                balance: balance,
            }
        }

        const userAccounts: Record<string, any>[] = Object.values(users)
        log.debug(`total users: ${userAccounts.length}`)

        const batchSize = 100
        for (let i = 0; i < userAccounts.length; i += batchSize) {
            const batch = userAccounts.slice(i, i + batchSize)
            log.info(
                `[GENESIS] Processing batch ${
                    Math.floor(i / batchSize) + 1
                }/${Math.ceil(userAccounts.length / batchSize)} (${
                    batch.length
                } accounts)`,
            )

            await Promise.all(
                batch.map(async user => {
                    await HandleGCR.createAccount(user.pubkey, user)
                }),
            )
        }
    }
}
