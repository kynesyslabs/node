import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Baseline migration: snapshots the schema that synchronize:true has been
 * producing on existing nodes. Uses IF NOT EXISTS clauses throughout so it's
 * a no-op on nodes that already have the schema, and a full bootstrap on
 * fresh nodes.
 *
 * Going forward, schema changes ship as discrete migration files alongside
 * the entity edits that motivate them; synchronize is off.
 */
export class Baseline1714000000000 implements MigrationInterface {
    public async up(qr: QueryRunner): Promise<void> {
        // ── blocks ─────────────────────────────────────────────────────────
        await qr.query(`
            CREATE TABLE IF NOT EXISTS "blocks" (
                "id" SERIAL PRIMARY KEY,
                "number" integer NOT NULL,
                "hash" character varying NOT NULL,
                "content" json NOT NULL,
                "status" character varying NOT NULL,
                "proposer" character varying NOT NULL,
                "next_proposer" character varying NOT NULL,
                "validation_data" json NOT NULL
            )
        `)
        await qr.query("CREATE INDEX IF NOT EXISTS \"idx_blocks_number\" ON \"blocks\" (\"number\")")
        await qr.query("CREATE INDEX IF NOT EXISTS \"idx_blocks_hash\" ON \"blocks\" (\"hash\")")

        // ── consensus ──────────────────────────────────────────────────────
        await qr.query(`
            CREATE TABLE IF NOT EXISTS "consensus" (
                "round" integer PRIMARY KEY,
                "lastBlockHash" text,
                "lastBlockTimestamp" text,
                "lastConsensusHash" text,
                "validators" text,
                "reports" text
            )
        `)

        // ── mempooltx ──────────────────────────────────────────────────────
        await qr.query(`
            CREATE TABLE IF NOT EXISTS "mempooltx" (
                "hash" text PRIMARY KEY,
                "timestamp" bigint NOT NULL,
                "content" json NOT NULL,
                "signature" json NOT NULL,
                "ed25519_signature" character varying,
                "status" text NOT NULL,
                "blockNumber" integer NOT NULL,
                "extra" jsonb,
                "nonce" bigint DEFAULT 0,
                "reference_block" integer NOT NULL
            )
        `)
        await qr.query("CREATE INDEX IF NOT EXISTS \"idx_mempooltx_hash\" ON \"mempooltx\" (\"hash\")")
        await qr.query("CREATE INDEX IF NOT EXISTS \"idx_mempooltx_reference_block\" ON \"mempooltx\" (\"reference_block\")")

        // ── pgp_key_server ─────────────────────────────────────────────────
        await qr.query(`
            CREATE TABLE IF NOT EXISTS "pgp_key_server" (
                "key" text PRIMARY KEY,
                "email" text,
                "address" text,
                "others" text
            )
        `)

        // ── transactions ───────────────────────────────────────────────────
        await qr.query(`
            CREATE TABLE IF NOT EXISTS "transactions" (
                "id" SERIAL PRIMARY KEY,
                "blockNumber" integer NOT NULL,
                "signature" character varying NOT NULL,
                "ed25519_signature" character varying,
                "status" character varying NOT NULL,
                "hash" character varying NOT NULL UNIQUE,
                "content" json NOT NULL,
                "type" character varying NOT NULL,
                "from" character varying NOT NULL,
                "from_ed25519_address" character varying,
                "to" character varying NOT NULL,
                "amount" bigint,
                "nonce" bigint DEFAULT 0,
                "timestamp" bigint NOT NULL,
                "networkFee" integer NOT NULL,
                "rpcFee" integer NOT NULL,
                "additionalFee" integer NOT NULL
            )
        `)
        await qr.query("CREATE INDEX IF NOT EXISTS \"idx_transactions_hash\" ON \"transactions\" (\"hash\")")
        await qr.query("CREATE INDEX IF NOT EXISTS \"idx_transactions_blockNumber\" ON \"transactions\" (\"blockNumber\")")
        await qr.query("CREATE INDEX IF NOT EXISTS \"idx_transactions_from_ed25519_address\" ON \"transactions\" (\"from_ed25519_address\")")
        await qr.query("CREATE INDEX IF NOT EXISTS \"idx_transactions_to\" ON \"transactions\" (\"to\")")

        // ── gcr_hashes ─────────────────────────────────────────────────────
        await qr.query(`
            CREATE TABLE IF NOT EXISTS "gcr_hashes" (
                "id" SERIAL PRIMARY KEY,
                "block" integer,
                "hash" text NOT NULL
            )
        `)

        // ── global_change_registry_subnets_txs ─────────────────────────────
        await qr.query(`
            CREATE TABLE IF NOT EXISTS "global_change_registry_subnets_txs" (
                "tx_hash" text PRIMARY KEY,
                "subnet_id" text NOT NULL,
                "status" text NOT NULL,
                "block_hash" text NOT NULL,
                "block_number" integer NOT NULL,
                "tx_data" json NOT NULL
            )
        `)

        // ── gcr_main ───────────────────────────────────────────────────────
        // Note: "assignedTxs" is still here in the baseline. The migration
        // that follows (MoveAssignedTxsToOwnTable) is what removes it.
        await qr.query(`
            CREATE TABLE IF NOT EXISTS "gcr_main" (
                "pubkey" text PRIMARY KEY,
                "assignedTxs" jsonb NOT NULL DEFAULT '[]'::jsonb,
                "nonce" integer NOT NULL,
                "balance" bigint NOT NULL,
                "identities" jsonb NOT NULL,
                "points" jsonb NOT NULL DEFAULT '{}'::jsonb,
                "referralInfo" jsonb NOT NULL DEFAULT '{}'::jsonb,
                "flagged" boolean NOT NULL DEFAULT false,
                "flaggedReason" text NOT NULL DEFAULT '',
                "reviewed" boolean NOT NULL DEFAULT false,
                "createdAt" timestamp NOT NULL DEFAULT now(),
                "updatedAt" timestamp NOT NULL DEFAULT now()
            )
        `)
        await qr.query("CREATE INDEX IF NOT EXISTS \"idx_gcr_main_pubkey\" ON \"gcr_main\" (\"pubkey\")")

        // ── gcr_tlsnotary ──────────────────────────────────────────────────
        await qr.query(`
            CREATE TABLE IF NOT EXISTS "gcr_tlsnotary" (
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
        await qr.query("CREATE INDEX IF NOT EXISTS \"idx_gcr_tlsnotary_owner\" ON \"gcr_tlsnotary\" (\"owner\")")
        await qr.query("CREATE INDEX IF NOT EXISTS \"idx_gcr_tlsnotary_domain\" ON \"gcr_tlsnotary\" (\"domain\")")
        await qr.query("CREATE INDEX IF NOT EXISTS \"idx_gcr_tlsnotary_txhash\" ON \"gcr_tlsnotary\" (\"txhash\")")

        // ── gcr_storageprogram ─────────────────────────────────────────────
        await qr.query(`
            CREATE TABLE IF NOT EXISTS "gcr_storageprogram" (
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
        await qr.query("CREATE INDEX IF NOT EXISTS \"idx_gcr_storageprogram_owner\" ON \"gcr_storageprogram\" (\"owner\")")
        await qr.query("CREATE INDEX IF NOT EXISTS \"idx_gcr_storageprogram_programname\" ON \"gcr_storageprogram\" (\"programName\")")
        await qr.query("CREATE INDEX IF NOT EXISTS \"idx_gcr_storageprogram_encoding\" ON \"gcr_storageprogram\" (\"encoding\")")
        await qr.query("CREATE INDEX IF NOT EXISTS \"idx_gcr_storageprogram_storagelocation\" ON \"gcr_storageprogram\" (\"storageLocation\")")

        // ── identity_commitments ───────────────────────────────────────────
        await qr.query(`
            CREATE TABLE IF NOT EXISTS "identity_commitments" (
                "commitment_hash" text PRIMARY KEY,
                "leaf_index" integer NOT NULL DEFAULT -1,
                "provider" text NOT NULL,
                "block_number" integer NOT NULL,
                "transaction_hash" text NOT NULL,
                "timestamp" bigint NOT NULL,
                "created_at" timestamp NOT NULL DEFAULT now()
            )
        `)
        await qr.query("CREATE INDEX IF NOT EXISTS \"idx_commitment_hash\" ON \"identity_commitments\" (\"commitment_hash\")")
        await qr.query("CREATE INDEX IF NOT EXISTS \"idx_commitment_provider\" ON \"identity_commitments\" (\"provider\")")
        await qr.query("CREATE INDEX IF NOT EXISTS \"idx_commitment_block\" ON \"identity_commitments\" (\"block_number\")")
        await qr.query("CREATE INDEX IF NOT EXISTS \"idx_commitment_leaf\" ON \"identity_commitments\" (\"leaf_index\")")

        // ── used_nullifiers ────────────────────────────────────────────────
        await qr.query(`
            CREATE TABLE IF NOT EXISTS "used_nullifiers" (
                "nullifier_hash" text PRIMARY KEY,
                "block_number" integer NOT NULL,
                "transaction_hash" text NOT NULL,
                "timestamp" bigint NOT NULL,
                "created_at" timestamp NOT NULL DEFAULT now()
            )
        `)
        await qr.query("CREATE INDEX IF NOT EXISTS \"idx_nullifier_hash\" ON \"used_nullifiers\" (\"nullifier_hash\")")
        await qr.query("CREATE INDEX IF NOT EXISTS \"idx_nullifier_block\" ON \"used_nullifiers\" (\"block_number\")")

        // ── merkle_tree_state ──────────────────────────────────────────────
        await qr.query(`
            CREATE TABLE IF NOT EXISTS "merkle_tree_state" (
                "tree_id" text PRIMARY KEY,
                "root_hash" text NOT NULL,
                "block_number" integer NOT NULL,
                "leaf_count" integer NOT NULL DEFAULT 0,
                "tree_snapshot" jsonb NOT NULL,
                "updated_at" timestamp NOT NULL DEFAULT now()
            )
        `)
        await qr.query("CREATE INDEX IF NOT EXISTS \"idx_merkle_tree_id\" ON \"merkle_tree_state\" (\"tree_id\")")
        await qr.query("CREATE INDEX IF NOT EXISTS \"idx_merkle_block\" ON \"merkle_tree_state\" (\"block_number\")")

        // ── offline_messages ───────────────────────────────────────────────
        await qr.query(`
            CREATE TABLE IF NOT EXISTS "offline_messages" (
                "id" SERIAL PRIMARY KEY,
                "recipient_public_key" text NOT NULL,
                "sender_public_key" text NOT NULL,
                "message_hash" text NOT NULL UNIQUE,
                "encrypted_content" jsonb NOT NULL,
                "signature" text NOT NULL,
                "timestamp" bigint NOT NULL,
                "status" text NOT NULL DEFAULT 'pending'
            )
        `)
        await qr.query("CREATE INDEX IF NOT EXISTS \"idx_offline_messages_recipient\" ON \"offline_messages\" (\"recipient_public_key\")")
        await qr.query("CREATE INDEX IF NOT EXISTS \"idx_offline_messages_sender\" ON \"offline_messages\" (\"sender_public_key\")")

        // ── l2ps_hashes ────────────────────────────────────────────────────
        await qr.query(`
            CREATE TABLE IF NOT EXISTS "l2ps_hashes" (
                "l2ps_uid" text PRIMARY KEY,
                "hash" text NOT NULL,
                "transaction_count" integer NOT NULL,
                "block_number" bigint NOT NULL DEFAULT 0,
                "timestamp" bigint NOT NULL
            )
        `)

        // ── l2ps_mempool ───────────────────────────────────────────────────
        await qr.query(`
            CREATE TABLE IF NOT EXISTS "l2ps_mempool" (
                "hash" text PRIMARY KEY,
                "l2ps_uid" text NOT NULL,
                "sequence_number" bigint NOT NULL DEFAULT 0,
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
        await qr.query("CREATE INDEX IF NOT EXISTS \"IDX_L2PS_UID_TIMESTAMP\" ON \"l2ps_mempool\" (\"l2ps_uid\", \"timestamp\")")
        await qr.query("CREATE INDEX IF NOT EXISTS \"IDX_L2PS_UID_STATUS\" ON \"l2ps_mempool\" (\"l2ps_uid\", \"status\")")
        await qr.query("CREATE INDEX IF NOT EXISTS \"IDX_L2PS_UID_BLOCK\" ON \"l2ps_mempool\" (\"l2ps_uid\", \"block_number\")")
        await qr.query("CREATE INDEX IF NOT EXISTS \"IDX_L2PS_UID_SEQUENCE\" ON \"l2ps_mempool\" (\"l2ps_uid\", \"sequence_number\")")
        await qr.query("CREATE INDEX IF NOT EXISTS \"idx_l2ps_mempool_original_hash\" ON \"l2ps_mempool\" (\"original_hash\")")
        await qr.query("CREATE INDEX IF NOT EXISTS \"idx_l2ps_mempool_timestamp\" ON \"l2ps_mempool\" (\"timestamp\")")
        await qr.query("CREATE INDEX IF NOT EXISTS \"idx_l2ps_mempool_block_number\" ON \"l2ps_mempool\" (\"block_number\")")

        // ── l2ps_transactions ──────────────────────────────────────────────
        await qr.query(`
            CREATE TABLE IF NOT EXISTS "l2ps_transactions" (
                "id" SERIAL PRIMARY KEY,
                "l2ps_uid" text NOT NULL,
                "hash" text NOT NULL UNIQUE,
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
                "created_at" timestamp NOT NULL DEFAULT now()
            )
        `)
        await qr.query("CREATE INDEX IF NOT EXISTS \"IDX_L2PS_TX_UID\" ON \"l2ps_transactions\" (\"l2ps_uid\")")
        await qr.query("CREATE INDEX IF NOT EXISTS \"IDX_L2PS_TX_HASH\" ON \"l2ps_transactions\" (\"hash\")")
        await qr.query("CREATE INDEX IF NOT EXISTS \"IDX_L2PS_TX_FROM\" ON \"l2ps_transactions\" (\"from_address\")")
        await qr.query("CREATE INDEX IF NOT EXISTS \"IDX_L2PS_TX_TO\" ON \"l2ps_transactions\" (\"to_address\")")
        await qr.query("CREATE INDEX IF NOT EXISTS \"IDX_L2PS_TX_L1_BATCH\" ON \"l2ps_transactions\" (\"l1_batch_hash\")")
        await qr.query("CREATE INDEX IF NOT EXISTS \"IDX_L2PS_TX_UID_FROM\" ON \"l2ps_transactions\" (\"l2ps_uid\", \"from_address\")")
        await qr.query("CREATE INDEX IF NOT EXISTS \"IDX_L2PS_TX_UID_TO\" ON \"l2ps_transactions\" (\"l2ps_uid\", \"to_address\")")
        await qr.query("CREATE INDEX IF NOT EXISTS \"IDX_L2PS_TX_BLOCK\" ON \"l2ps_transactions\" (\"l1_block_number\")")

        // ── l2ps_proofs ────────────────────────────────────────────────────
        await qr.query(`
            CREATE TABLE IF NOT EXISTS "l2ps_proofs" (
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
                "transaction_hashes" jsonb NOT NULL DEFAULT '[]'::jsonb,
                "error_message" text,
                "created_at" timestamp NOT NULL DEFAULT now(),
                "processed_at" timestamp
            )
        `)
        await qr.query("CREATE INDEX IF NOT EXISTS \"IDX_L2PS_PROOFS_UID\" ON \"l2ps_proofs\" (\"l2ps_uid\")")
        await qr.query("CREATE INDEX IF NOT EXISTS \"IDX_L2PS_PROOFS_STATUS\" ON \"l2ps_proofs\" (\"status\")")
        await qr.query("CREATE INDEX IF NOT EXISTS \"IDX_L2PS_PROOFS_BLOCK\" ON \"l2ps_proofs\" (\"target_block_number\")")
        await qr.query("CREATE INDEX IF NOT EXISTS \"IDX_L2PS_PROOFS_BATCH_HASH\" ON \"l2ps_proofs\" (\"l1_batch_hash\")")
        await qr.query("CREATE INDEX IF NOT EXISTS \"IDX_L2PS_PROOFS_UID_STATUS\" ON \"l2ps_proofs\" (\"l2ps_uid\", \"status\")")
    }

    public async down(_qr: QueryRunner): Promise<void> {
        // Baseline migration: no-down. Reverting the baseline would mean
        // wiping the entire schema, which is never the right answer in a
        // running system. Drop the database manually if that's truly the
        // intent.
        throw new Error("Baseline migration cannot be reverted automatically")
    }
}
