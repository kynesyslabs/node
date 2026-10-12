import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Schema for the token feature: the `gcr_tokens` table (GCRToken entity) and the
 * `gcr_main.extended` JSONB column (GCRMain.extended, holds token holder references).
 *
 * Production runs with `synchronize: false`, so without this migration those nodes would
 * start with no token table and no `extended` column. Dev/test databases built with
 * `synchronize: true` already have both, hence IF NOT EXISTS: `up` is a no-op there.
 *
 * Existing `gcr_main` rows get the default `extended` value; ADD COLUMN with a constant
 * default does not rewrite the table on Postgres >= 11.
 */
export class AddTokenTables1791763200000 implements MigrationInterface {
    name = "AddTokenTables1791763200000"

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "gcr_tokens" (
                "address" text NOT NULL,
                "name" text NOT NULL,
                "ticker" text NOT NULL,
                "decimals" integer NOT NULL,
                "deployer" text NOT NULL,
                "deployerNonce" integer NOT NULL,
                "deployedAt" bigint NOT NULL,
                "hasScript" boolean NOT NULL DEFAULT false,
                "totalSupply" text NOT NULL,
                "balances" jsonb NOT NULL DEFAULT '{}',
                "allowances" jsonb NOT NULL DEFAULT '{}',
                "customState" jsonb NOT NULL DEFAULT '{}',
                "owner" text NOT NULL,
                "paused" boolean NOT NULL DEFAULT false,
                "aclEntries" jsonb NOT NULL DEFAULT '[]',
                "script" jsonb,
                "scriptVersion" integer NOT NULL DEFAULT 0,
                "lastScriptUpdate" bigint,
                "deployTxHash" text NOT NULL,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_gcr_tokens_address" PRIMARY KEY ("address")
            )
        `)
        await queryRunner.query(
            "CREATE INDEX IF NOT EXISTS \"idx_gcr_tokens_deployer\" ON \"gcr_tokens\" (\"deployer\")",
        )
        await queryRunner.query(
            "CREATE INDEX IF NOT EXISTS \"idx_gcr_tokens_ticker\" ON \"gcr_tokens\" (\"ticker\")",
        )
        await queryRunner.query(
            "ALTER TABLE \"gcr_main\" ADD COLUMN IF NOT EXISTS \"extended\" jsonb NOT NULL DEFAULT '{\"tokens\":[],\"nfts\":[],\"xm\":[],\"web2\":[],\"other\":[]}'",
        )
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            "ALTER TABLE \"gcr_main\" DROP COLUMN IF EXISTS \"extended\"",
        )
        await queryRunner.query("DROP TABLE IF EXISTS \"gcr_tokens\"")
    }
}
