import log from "src/utilities/logger"
import Block from "./block"
import Mempool from "./mempool"
import Transaction from "./transaction"
import Hashing from "../crypto/hashing"
import { getSharedState } from "src/utilities/sharedState"
import HandleGCR from "./gcr/handleGCR"
import getCommonValidatorSeed from "../consensus/v2/routines/getCommonValidatorSeed"
import { insertBlock } from "./chainBlocks"
import type { Operation } from "@kynesyslabs/demosdk/types"
import {
    serializeTransactionContent,
    serializeBlockContent,
} from "@/forks"
import Datasource from "src/model/datasource"
import { loadSnapshot } from "src/libs/blockchain/genesis/loadSnapshot"
import { restoreSnapshot } from "src/libs/blockchain/genesis/restoreSnapshot"
import {
    seedValidators,
    type GenesisValidatorSeed,
} from "src/libs/blockchain/genesis/seedValidators"
import { applyForksAtGenesis } from "src/libs/blockchain/genesis/applyForksAtGenesis"
import { mergeGenesisBalances } from "src/libs/blockchain/genesis/mergeGenesisBalances"

const GENESIS_BLOCK_HEIGHT = 0

export async function generateGenesisBlock(genesisData: any): Promise<Block> {
    const genesisBlock = new Block()
    genesisBlock.number = 0

    const genesisTx = new Transaction()
    genesisTx.content.type = "genesis"
    genesisTx.blockNumber = 0
    genesisTx.content.to = {
        type: getSharedState.signingAlgorithm,
        data: new Uint8Array(Buffer.from("0x0", "hex")),
    }.data.toString()
    genesisTx.content.from = {
        type: getSharedState.signingAlgorithm,
        data: new Uint8Array(Buffer.from("0x0", "hex")),
    }.data.toString()
    genesisTx.content.from_ed25519_address = ""
    genesisTx.signature = {
        type: getSharedState.signingAlgorithm,
        data: "0x0",
    }
    genesisTx.status = "confirmed"

    if (!genesisData.timestamp) {
        genesisTx.content.timestamp = Date.now()
    } else {
        genesisTx.content.timestamp = parseInt(genesisData.timestamp)
    }
    genesisTx.content.amount = 0
    genesisTx.content.nonce = 0
    genesisTx.content.transaction_fee.network_fee = 0
    genesisTx.content.transaction_fee.rpc_fee = 0
    genesisTx.content.transaction_fee.additional_fee = 0

    genesisTx.hash = Hashing.sha256(
        serializeTransactionContent(genesisTx.content, GENESIS_BLOCK_HEIGHT),
    )

    genesisBlock.content.timestamp = genesisTx.content.timestamp
    genesisBlock.content.ordered_transactions.push(genesisTx.hash)
    genesisBlock.content.previousHash = "0x0"
    genesisBlock.content["extra"] = {
        genesisData: JSON.stringify(genesisData),
    }
    genesisBlock.status = "confirmed"
    genesisBlock.proposer = "0x000000000000000000000000"
    genesisBlock.content.encrypted_transactions_hashes = new Map()
    genesisBlock.validation_data = {
        signatures: {
            "0x000000000000000000000000": "0x0",
        },
    }
    genesisBlock.hash = Hashing.sha256(
        serializeBlockContent(genesisBlock.content, GENESIS_BLOCK_HEIGHT),
    )

    const { commonValidatorSeed } = await getCommonValidatorSeed(
        genesisBlock as any,
    )
    genesisBlock.next_proposer = commonValidatorSeed

    const genesisOp: Operation = {
        operator: "genesis",
        actor: "DEMOS Network",
        params: genesisData,
        hash: genesisBlock.hash,
        nonce: 0,
        timestamp: genesisBlock.content.timestamp,
        status: true,
        fees: {
            network_fee: 0,
            rpc_fee: 0,
            additional_fee: 0,
            // DEM-665: Operations are internal — they do not carry a
            // routing rpc_address. The field is structurally required
            // by the SDK's TxFee interface so we set `null`.
            rpc_address: null,
        },
    }

    log.debug("[GENESIS] Block generated, ready to insert it")
    log.debug("[GENESIS] inserting transaction into the mempool")
    await Mempool.addTransaction({ ...genesisTx, reference_block: 0 })
    log.debug("[GENESIS] inserted transaction")

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
    const snapshot = await loadSnapshot()

    if (snapshot.available) {
        const db = await Datasource.getInstance()
        const dataSource = db.getDataSource()
        // Wrap the entire restore in one transaction so partial failure
        // leaves the DB empty (otherwise a crash mid-restore would yield
        // corrupted half-restored state that the next boot's preflight
        // would refuse to retry).
        await dataSource.transaction(async em => {
            await restoreSnapshot(em, snapshot)
            // Genesis-baked validators: seed from data/genesis.json inside
            // the same transaction so a partial restore never ships without
            // the founding validator set (and vice-versa).
            if (
                Array.isArray(genesisData.validators) &&
                (genesisData.validators as unknown[]).length > 0
            ) {
                await seedValidators(
                    em,
                    genesisData.validators as GenesisValidatorSeed[],
                )
            }
            // Overlay genesisData.balances on top of the snapshot rows.
            // Historical behavior silently dropped balances when a
            // snapshot was present — operator-written top-ups (e.g.
            // founder/incentives wallets added in `data/genesis.json`)
            // ended up at balance=0 once `ensureGCRForUser` later
            // created the row. Block-0 hash already commits to
            // `genesisData.balances` via `extra.genesisData`, so making
            // the disk reflect it does not change consensus — it just
            // closes the gap between hash and state.
            await mergeGenesisBalances(em, genesisData.balances)
            // Pre-apply forks deterministically at genesis. Migration output is
            // a pure function of input state — no consensus block-1 hook needed.
            // Pristine boot is fully post-fork; solo nodes don't sit at genesis.
            await applyForksAtGenesis(em, genesisData.forks)
        })
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
    // !SECTION Restoring account data

    await insertBlock(genesisBlock, [genesisOp], 0)
    return genesisBlock
}

export async function generateGenesisBlocks(genesisJsons: any[]): Promise<string> {
    const compiledBlock = ""
    // TODO
    return compiledBlock
}

export async function getGenesisUniqueBlock() {
    // TODO
}
