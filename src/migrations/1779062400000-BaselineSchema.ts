/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Baseline schema — fresh database initialisation.
 *
 * Reflects the **current** state of every TypeORM entity registered in
 * `src/model/datasource.ts`. Designed to run against an empty database;
 * no IF NOT EXISTS guards (we don't need them, and not having them surfaces
 * schema drift loudly during local resets).
 *
 * Anything later than this baseline goes into its own dated migration.
 */
export class BaselineSchema1779062400000 implements MigrationInterface {
    name = "BaselineSchema1779062400000"

    public async up(queryRunner: QueryRunner): Promise<void> {
        // ─── blocks ────────────────────────────────────────────────────
        await queryRunner.query(`
            CREATE TABLE "blocks" (
                "id" SERIAL PRIMARY KEY,
                "number" integer NOT NULL,
                "hash" varchar NOT NULL,
                "content" json NOT NULL,
                "status" varchar NOT NULL,
                "proposer" varchar NOT NULL,
                "next_proposer" varchar NOT NULL,
                "validation_data" json NOT NULL
            )
        `)
        await queryRunner.query(
            "CREATE INDEX \"idx_blocks_number\" ON \"blocks\" (\"number\")",
        )
        await queryRunner.query(
            "CREATE INDEX \"idx_blocks_hash\" ON \"blocks\" (\"hash\")",
        )

        // ─── consensus ─────────────────────────────────────────────────
        await queryRunner.query(`
            CREATE TABLE "consensus" (
                "round" integer PRIMARY KEY,
                "lastBlockHash" text,
                "lastBlockTimestamp" text,
                "lastConsensusHash" text,
                "validators" text,
                "reports" text
            )
        `)

        // ─── mempooltx ─────────────────────────────────────────────────
        await queryRunner.query(`
            CREATE TABLE "mempooltx" (
                "hash" text PRIMARY KEY,
                "timestamp" bigint NOT NULL,
                "content" json NOT NULL,
                "signature" json NOT NULL,
                "ed25519_signature" varchar,
                "status" text NOT NULL,
                "blockNumber" integer NOT NULL,
                "extra" jsonb,
                "nonce" bigint DEFAULT 0,
                "reference_block" integer NOT NULL
            )
        `)
        await queryRunner.query(
            "CREATE INDEX \"idx_mempooltx_hash\" ON \"mempooltx\" (\"hash\")",
        )
        await queryRunner.query(
            "CREATE INDEX \"idx_mempooltx_reference_block\" ON \"mempooltx\" (\"reference_block\")",
        )

        // ─── pgp_key_server ───────────────────────────────────────────
        await queryRunner.query(`
            CREATE TABLE "pgp_key_server" (
                "key" text PRIMARY KEY,
                "email" text,
                "address" text,
                "others" text
            )
        `)

        // ─── transactions ─────────────────────────────────────────────
        // Fees are bigint (post-widening) with default 0.
        // rpcAddress (DEM-665) is included.
        await queryRunner.query(`
            CREATE TABLE "transactions" (
                "id" SERIAL PRIMARY KEY,
                "blockNumber" integer NOT NULL,
                "signature" varchar NOT NULL,
                "ed25519_signature" varchar,
                "status" varchar NOT NULL,
                "hash" varchar NOT NULL,
                "content" json NOT NULL,
                "type" varchar NOT NULL,
                "from" varchar NOT NULL,
                "from_ed25519_address" varchar,
                "to" varchar NOT NULL,
                "amount" bigint,
                "nonce" bigint DEFAULT 0,
                "timestamp" bigint NOT NULL,
                "networkFee" bigint DEFAULT 0,
                "rpcFee" bigint DEFAULT 0,
                "additionalFee" bigint DEFAULT 0,
                "rpcAddress" varchar,
                CONSTRAINT "uq_transactions_hash" UNIQUE ("hash")
            )
        `)
        await queryRunner.query(
            "CREATE INDEX \"idx_transactions_hash\" ON \"transactions\" (\"hash\")",
        )
        await queryRunner.query(
            "CREATE INDEX \"idx_transactions_blockNumber\" ON \"transactions\" (\"blockNumber\")",
        )
        await queryRunner.query(
            "CREATE INDEX \"idx_transactions_from_ed25519_address\" ON \"transactions\" (\"from_ed25519_address\")",
        )
        await queryRunner.query(
            "CREATE INDEX \"idx_transactions_to\" ON \"transactions\" (\"to\")",
        )

        // ─── validators ───────────────────────────────────────────────
        await queryRunner.query(`
            CREATE TABLE "validators" (
                "address" text PRIMARY KEY,
                "status" text,
                "connection_url" text,
                "staked_amount" text DEFAULT '0',
                "first_seen" integer,
                "valid_at" integer,
                "unstake_requested_at" integer,
                "unstake_available_at" integer
            )
        `)
        await queryRunner.query(
            "CREATE INDEX \"idx_validators_unstake_requested_at\" ON \"validators\" (\"unstake_requested_at\")",
        )
        await queryRunner.query(
            "CREATE INDEX \"idx_validators_unstake_available_at\" ON \"validators\" (\"unstake_available_at\")",
        )

        // ─── gcr_hashes ───────────────────────────────────────────────
        await queryRunner.query(`
            CREATE TABLE "gcr_hashes" (
                "id" SERIAL PRIMARY KEY,
                "block" integer,
                "hash" text NOT NULL
            )
        `)

        // ─── gcr_subnets_txs ──────────────────────────────────────────
        await queryRunner.query(`
            CREATE TABLE "gcr_subnets_txs" (
                "tx_hash" text PRIMARY KEY,
                "subnet_id" text NOT NULL,
                "status" text NOT NULL,
                "block_hash" text NOT NULL,
                "block_number" integer NOT NULL,
                "tx_data" json NOT NULL
            )
        `)

        // ─── gcr_main ─────────────────────────────────────────────────
        // balance is numeric(38, 0) so balance*1e9 cannot overflow during
        // the DEM → OS denomination fork (myc#85, GH#3213220467).
        await queryRunner.query(`
            CREATE TABLE "gcr_main" (
                "pubkey" text PRIMARY KEY,
                "nonce" integer NOT NULL,
                "balance" numeric(38, 0) NOT NULL DEFAULT '0',
                "identities" jsonb NOT NULL,
                "points" jsonb NOT NULL DEFAULT '{}',
                "referralInfo" jsonb NOT NULL DEFAULT '{}',
                "flagged" boolean NOT NULL DEFAULT false,
                "flaggedReason" text NOT NULL DEFAULT '',
                "reviewed" boolean NOT NULL DEFAULT false,
                "createdAt" timestamp NOT NULL DEFAULT now(),
                "updatedAt" timestamp NOT NULL DEFAULT now()
            )
        `)
        await queryRunner.query(
            "CREATE INDEX \"idx_gcr_main_pubkey\" ON \"gcr_main\" (\"pubkey\")",
        )

        // ─── gcr_assigned_txs ─────────────────────────────────────────
        await queryRunner.query(`
            CREATE TABLE "gcr_assigned_txs" (
                "pubkey" text NOT NULL,
                "tx_hash" text NOT NULL,
                "block_number" integer NOT NULL DEFAULT 0,
                "assigned_at" timestamptz NOT NULL DEFAULT now(),
                PRIMARY KEY ("pubkey", "tx_hash")
            )
        `)
        await queryRunner.query(
            "CREATE INDEX \"idx_gcr_assigned_txs_pubkey\" ON \"gcr_assigned_txs\" (\"pubkey\", \"block_number\")",
        )

        // ─── gcr_tlsnotary ────────────────────────────────────────────
        await queryRunner.query(`
            CREATE TABLE "gcr_tlsnotary" (
                "tokenId" text PRIMARY KEY,
                "owner" text NOT NULL,
                "domain" text NOT NULL,
                "proof" text NOT NULL,
                "storageType" text NOT NULL,
                "txhash" text NOT NULL,
                "proofTimestamp" bigint NOT NULL,
                "createdAt" timestamp NOT NULL DEFAULT now()
            )
        `)
        await queryRunner.query(
            "CREATE INDEX \"idx_gcr_tlsnotary_owner\" ON \"gcr_tlsnotary\" (\"owner\")",
        )
        await queryRunner.query(
            "CREATE INDEX \"idx_gcr_tlsnotary_domain\" ON \"gcr_tlsnotary\" (\"domain\")",
        )
        await queryRunner.query(
            "CREATE INDEX \"idx_gcr_tlsnotary_txhash\" ON \"gcr_tlsnotary\" (\"txhash\")",
        )

        // ─── gcr_storageprogram ──────────────────────────────────────
        await queryRunner.query(`
            CREATE TABLE "gcr_storageprogram" (
                "storageAddress" text PRIMARY KEY,
                "owner" text NOT NULL,
                "programName" text NOT NULL,
                "encoding" text NOT NULL,
                "data" jsonb,
                "sizeBytes" integer NOT NULL,
                "acl" jsonb NOT NULL,
                "metadata" jsonb,
                "storageLocation" text NOT NULL DEFAULT 'onchain',
                "ipfsCid" text,
                "salt" text,
                "createdByTx" text NOT NULL,
                "lastModifiedByTx" text NOT NULL,
                "totalFeesPaid" bigint NOT NULL,
                "isDeleted" boolean NOT NULL DEFAULT false,
                "interactionTxs" text NOT NULL DEFAULT '',
                "deletedByTx" text,
                "createdAt" timestamp NOT NULL DEFAULT now(),
                "updatedAt" timestamp NOT NULL DEFAULT now()
            )
        `)
        await queryRunner.query(
            "CREATE INDEX \"idx_gcr_storageprogram_owner\" ON \"gcr_storageprogram\" (\"owner\")",
        )
        await queryRunner.query(
            "CREATE INDEX \"idx_gcr_storageprogram_programname\" ON \"gcr_storageprogram\" (\"programName\")",
        )
        await queryRunner.query(
            "CREATE INDEX \"idx_gcr_storageprogram_encoding\" ON \"gcr_storageprogram\" (\"encoding\")",
        )
        await queryRunner.query(
            "CREATE INDEX \"idx_gcr_storageprogram_storagelocation\" ON \"gcr_storageprogram\" (\"storageLocation\")",
        )

        // ─── identity_commitments ────────────────────────────────────
        await queryRunner.query(`
            CREATE TABLE "identity_commitments" (
                "commitment_hash" text PRIMARY KEY,
                "leaf_index" integer NOT NULL DEFAULT -1,
                "provider" text NOT NULL,
                "block_number" integer NOT NULL,
                "transaction_hash" text NOT NULL,
                "timestamp" bigint NOT NULL,
                "created_at" timestamp NOT NULL DEFAULT now()
            )
        `)
        await queryRunner.query(
            "CREATE INDEX \"idx_commitment_hash\" ON \"identity_commitments\" (\"commitment_hash\")",
        )
        await queryRunner.query(
            "CREATE INDEX \"idx_commitment_provider\" ON \"identity_commitments\" (\"provider\")",
        )
        await queryRunner.query(
            "CREATE INDEX \"idx_commitment_block\" ON \"identity_commitments\" (\"block_number\")",
        )
        await queryRunner.query(
            "CREATE INDEX \"idx_commitment_leaf\" ON \"identity_commitments\" (\"leaf_index\")",
        )

        // ─── used_nullifiers ─────────────────────────────────────────
        await queryRunner.query(`
            CREATE TABLE "used_nullifiers" (
                "nullifier_hash" text PRIMARY KEY,
                "block_number" integer NOT NULL,
                "transaction_hash" text NOT NULL,
                "timestamp" bigint NOT NULL,
                "created_at" timestamp NOT NULL DEFAULT now()
            )
        `)
        await queryRunner.query(
            "CREATE INDEX \"idx_nullifier_hash\" ON \"used_nullifiers\" (\"nullifier_hash\")",
        )
        await queryRunner.query(
            "CREATE INDEX \"idx_nullifier_block\" ON \"used_nullifiers\" (\"block_number\")",
        )

        // ─── merkle_tree_state ───────────────────────────────────────
        await queryRunner.query(`
            CREATE TABLE "merkle_tree_state" (
                "tree_id" text PRIMARY KEY,
                "root_hash" text NOT NULL,
                "block_number" integer NOT NULL,
                "leaf_count" integer NOT NULL DEFAULT 0,
                "tree_snapshot" jsonb NOT NULL,
                "updated_at" timestamp NOT NULL DEFAULT now()
            )
        `)
        await queryRunner.query(
            "CREATE INDEX \"idx_merkle_tree_id\" ON \"merkle_tree_state\" (\"tree_id\")",
        )
        await queryRunner.query(
            "CREATE INDEX \"idx_merkle_block\" ON \"merkle_tree_state\" (\"block_number\")",
        )

        // ─── offline_messages ────────────────────────────────────────
        await queryRunner.query(`
            CREATE TABLE "offline_messages" (
                "id" SERIAL PRIMARY KEY,
                "recipient_public_key" text NOT NULL,
                "sender_public_key" text NOT NULL,
                "message_hash" text NOT NULL,
                "encrypted_content" jsonb NOT NULL,
                "signature" text NOT NULL,
                "timestamp" bigint NOT NULL,
                "status" text NOT NULL DEFAULT 'pending',
                CONSTRAINT "uq_offline_messages_message_hash" UNIQUE ("message_hash")
            )
        `)
        await queryRunner.query(
            "CREATE INDEX \"idx_offline_messages_recipient_public_key\" ON \"offline_messages\" (\"recipient_public_key\")",
        )
        await queryRunner.query(
            "CREATE INDEX \"idx_offline_messages_sender_public_key\" ON \"offline_messages\" (\"sender_public_key\")",
        )

        // ─── l2ps_hashes ─────────────────────────────────────────────
        await queryRunner.query(`
            CREATE TABLE "l2ps_hashes" (
                "l2ps_uid" text PRIMARY KEY,
                "hash" text NOT NULL,
                "transaction_count" integer NOT NULL,
                "block_number" bigint NOT NULL DEFAULT 0,
                "timestamp" bigint NOT NULL
            )
        `)

        // ─── l2ps_mempool ────────────────────────────────────────────
        await queryRunner.query(`
            CREATE TABLE "l2ps_mempool" (
                "hash" text PRIMARY KEY,
                "l2ps_uid" text NOT NULL,
                "sequence_number" bigint NOT NULL DEFAULT '0',
                "original_hash" text NOT NULL,
                "encrypted_tx" jsonb NOT NULL,
                "status" text NOT NULL,
                "timestamp" bigint NOT NULL,
                "block_number" integer NOT NULL,
                "gcr_edits" jsonb,
                "affected_accounts_count" integer DEFAULT 0,
                CONSTRAINT "UQ_L2PS_UID_SEQUENCE" UNIQUE ("l2ps_uid", "sequence_number")
            )
        `)
        await queryRunner.query(
            "CREATE INDEX \"IDX_L2PS_UID_TIMESTAMP\" ON \"l2ps_mempool\" (\"l2ps_uid\", \"timestamp\")",
        )
        await queryRunner.query(
            "CREATE INDEX \"IDX_L2PS_UID_STATUS\" ON \"l2ps_mempool\" (\"l2ps_uid\", \"status\")",
        )
        await queryRunner.query(
            "CREATE INDEX \"IDX_L2PS_UID_BLOCK\" ON \"l2ps_mempool\" (\"l2ps_uid\", \"block_number\")",
        )
        await queryRunner.query(
            "CREATE INDEX \"IDX_L2PS_UID_SEQUENCE\" ON \"l2ps_mempool\" (\"l2ps_uid\", \"sequence_number\")",
        )
        await queryRunner.query(
            "CREATE INDEX \"idx_l2ps_mempool_original_hash\" ON \"l2ps_mempool\" (\"original_hash\")",
        )
        await queryRunner.query(
            "CREATE INDEX \"idx_l2ps_mempool_timestamp\" ON \"l2ps_mempool\" (\"timestamp\")",
        )
        await queryRunner.query(
            "CREATE INDEX \"idx_l2ps_mempool_block_number\" ON \"l2ps_mempool\" (\"block_number\")",
        )

        // ─── l2ps_transactions ───────────────────────────────────────
        await queryRunner.query(`
            CREATE TABLE "l2ps_transactions" (
                "id" SERIAL PRIMARY KEY,
                "l2ps_uid" text NOT NULL,
                "hash" text NOT NULL,
                "encrypted_hash" text,
                "l1_batch_hash" text,
                "l1_block_number" integer,
                "batch_index" integer NOT NULL DEFAULT 0,
                "type" text NOT NULL,
                "from_address" text NOT NULL,
                "to_address" text NOT NULL,
                "amount" bigint NOT NULL DEFAULT 0,
                "nonce" bigint NOT NULL DEFAULT 0,
                "timestamp" bigint NOT NULL,
                "status" text NOT NULL DEFAULT 'pending',
                "content" jsonb NOT NULL,
                "execution_message" text,
                "created_at" timestamp NOT NULL DEFAULT now(),
                CONSTRAINT "uq_l2ps_transactions_hash" UNIQUE ("hash")
            )
        `)
        await queryRunner.query(
            "CREATE INDEX \"IDX_L2PS_TX_UID\" ON \"l2ps_transactions\" (\"l2ps_uid\")",
        )
        await queryRunner.query(
            "CREATE INDEX \"IDX_L2PS_TX_HASH\" ON \"l2ps_transactions\" (\"hash\")",
        )
        await queryRunner.query(
            "CREATE INDEX \"IDX_L2PS_TX_FROM\" ON \"l2ps_transactions\" (\"from_address\")",
        )
        await queryRunner.query(
            "CREATE INDEX \"IDX_L2PS_TX_TO\" ON \"l2ps_transactions\" (\"to_address\")",
        )
        await queryRunner.query(
            "CREATE INDEX \"IDX_L2PS_TX_L1_BATCH\" ON \"l2ps_transactions\" (\"l1_batch_hash\")",
        )
        await queryRunner.query(
            "CREATE INDEX \"IDX_L2PS_TX_UID_FROM\" ON \"l2ps_transactions\" (\"l2ps_uid\", \"from_address\")",
        )
        await queryRunner.query(
            "CREATE INDEX \"IDX_L2PS_TX_UID_TO\" ON \"l2ps_transactions\" (\"l2ps_uid\", \"to_address\")",
        )
        await queryRunner.query(
            "CREATE INDEX \"IDX_L2PS_TX_BLOCK\" ON \"l2ps_transactions\" (\"l1_block_number\")",
        )

        // ─── l2ps_proofs ─────────────────────────────────────────────
        await queryRunner.query(`
            CREATE TABLE "l2ps_proofs" (
                "id" SERIAL PRIMARY KEY,
                "l2ps_uid" text NOT NULL,
                "l1_batch_hash" text NOT NULL,
                "proof" jsonb NOT NULL,
                "gcr_edits" jsonb NOT NULL,
                "affected_accounts_count" integer NOT NULL DEFAULT 0,
                "target_block_number" integer,
                "applied_block_number" integer,
                "status" text NOT NULL DEFAULT 'pending',
                "transaction_count" integer NOT NULL DEFAULT 1,
                "transactions_hash" text NOT NULL,
                "transaction_hashes" jsonb NOT NULL DEFAULT '[]',
                "error_message" text,
                "created_at" timestamp NOT NULL DEFAULT now(),
                "processed_at" timestamp
            )
        `)
        await queryRunner.query(
            "CREATE INDEX \"IDX_L2PS_PROOFS_UID\" ON \"l2ps_proofs\" (\"l2ps_uid\")",
        )
        await queryRunner.query(
            "CREATE INDEX \"IDX_L2PS_PROOFS_STATUS\" ON \"l2ps_proofs\" (\"status\")",
        )
        await queryRunner.query(
            "CREATE INDEX \"IDX_L2PS_PROOFS_BLOCK\" ON \"l2ps_proofs\" (\"target_block_number\")",
        )
        await queryRunner.query(
            "CREATE INDEX \"IDX_L2PS_PROOFS_BATCH_HASH\" ON \"l2ps_proofs\" (\"l1_batch_hash\")",
        )
        await queryRunner.query(
            "CREATE INDEX \"IDX_L2PS_PROOFS_UID_STATUS\" ON \"l2ps_proofs\" (\"l2ps_uid\", \"status\")",
        )

        // ─── network_upgrades ────────────────────────────────────────
        await queryRunner.query(`
            CREATE TABLE "network_upgrades" (
                "id" SERIAL PRIMARY KEY,
                "proposal_id" text NOT NULL,
                "version" integer NOT NULL,
                "proposer_public_key" text NOT NULL,
                "proposed_parameters" jsonb NOT NULL,
                "status" text NOT NULL,
                "snapshot_block" integer NOT NULL,
                "tally_block" integer NOT NULL,
                "effective_at_block" integer NOT NULL,
                "rationale" text NOT NULL,
                "created_at" timestamp NOT NULL DEFAULT now(),
                CONSTRAINT "uq_network_upgrades_proposal_id" UNIQUE ("proposal_id")
            )
        `)
        await queryRunner.query(
            "CREATE INDEX \"idx_network_upgrades_proposal_id\" ON \"network_upgrades\" (\"proposal_id\")",
        )
        await queryRunner.query(
            "CREATE INDEX \"idx_network_upgrades_status\" ON \"network_upgrades\" (\"status\")",
        )
        await queryRunner.query(
            "CREATE INDEX \"idx_network_upgrades_effective_at_block\" ON \"network_upgrades\" (\"effective_at_block\")",
        )

        // ─── network_upgrade_votes ───────────────────────────────────
        await queryRunner.query(`
            CREATE TABLE "network_upgrade_votes" (
                "id" SERIAL PRIMARY KEY,
                "proposal_id" text NOT NULL,
                "voter_address" text NOT NULL,
                "approve" boolean NOT NULL,
                "weight" text NOT NULL,
                "block_number" integer NOT NULL,
                "created_at" timestamp NOT NULL DEFAULT now(),
                CONSTRAINT "uq_proposal_voter" UNIQUE ("proposal_id", "voter_address")
            )
        `)
        await queryRunner.query(
            "CREATE INDEX \"idx_network_upgrade_votes_proposal_id\" ON \"network_upgrade_votes\" (\"proposal_id\")",
        )

        // ─── fork_state ──────────────────────────────────────────────
        // P3b — persistent DEM→OS fork-activation ledger.
        await queryRunner.query(`
            CREATE TABLE "fork_state" (
                "fork_name" text PRIMARY KEY,
                "applied" boolean NOT NULL DEFAULT false,
                "applied_at_block" bigint,
                "applied_at" timestamp,
                "pre_sum_dem" text,
                "post_sum_os" text,
                "gcr_v2_row_count" integer,
                "legacy_row_count" integer,
                "validators_row_count" integer,
                "capped_count" integer,
                "total_value_lost_os" text,
                "malformed_validators_count" integer
            )
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // No foreign keys, so drop order doesn't matter — alphabetical
        // for readability.
        const tables = [
            "blocks",
            "consensus",
            "fork_state",
            "gcr_assigned_txs",
            "gcr_hashes",
            "gcr_main",
            "gcr_storageprogram",
            "gcr_tlsnotary",
            "gcr_subnets_txs",
            "identity_commitments",
            "l2ps_hashes",
            "l2ps_mempool",
            "l2ps_proofs",
            "l2ps_transactions",
            "mempooltx",
            "merkle_tree_state",
            "network_upgrade_votes",
            "network_upgrades",
            "offline_messages",
            "pgp_key_server",
            "transactions",
            "used_nullifiers",
            "validators",
        ]
        for (const t of tables) {
            await queryRunner.query(`DROP TABLE "${t}"`)
        }
    }
}
