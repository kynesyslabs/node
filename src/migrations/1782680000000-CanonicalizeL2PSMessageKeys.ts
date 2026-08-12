/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Canonicalise stored L2PS-message peer keys.
 *
 * External SDKs send the same ed25519 public key in several equivalent
 * forms — with a `0x`/`0X` prefix or in mixed case. An earlier build
 * persisted `from_key`/`to_key` verbatim, so a message queued for an
 * offline peer could be stored under a non-canonical variant. Reads now
 * look rows up by the single canonical identity (leading `0x`/`0X`
 * stripped, lowercased), so any legacy row under a different variant
 * would be stranded forever.
 *
 * This one-shot pass rewrites every non-canonical row to its canonical
 * form, matching `canonicalizeKey()` exactly: `lower(regexp_replace(k,
 * '^0[xX]', ''))` strips a single leading prefix (anchored, non-global)
 * then lowercases. After it runs, canonical-only lookups are complete.
 *
 * Idempotent — re-running touches nothing (the WHERE guard excludes
 * already-canonical rows).
 */
export class CanonicalizeL2PSMessageKeys1782680000000
    implements MigrationInterface
{
    name = "CanonicalizeL2PSMessageKeys1782680000000"

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            UPDATE "l2ps_messages"
            SET "to_key"   = lower(regexp_replace("to_key",   '^0[xX]', '')),
                "from_key" = lower(regexp_replace("from_key", '^0[xX]', ''))
            WHERE "to_key"   <> lower(regexp_replace("to_key",   '^0[xX]', ''))
               OR "from_key" <> lower(regexp_replace("from_key", '^0[xX]', ''))
        `)
    }

    public async down(): Promise<void> {
        // Irreversible: canonicalisation discards the original prefix and
        // casing, so the pre-migration representation cannot be restored.
        // A no-op down keeps the migration runner consistent without
        // pretending to recover lost information.
    }
}
