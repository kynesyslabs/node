import { MigrationInterface, QueryRunner } from "typeorm"

export class AddReferralSupport1703123456789 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        // Add referrals field to points breakdown for existing records
        await queryRunner.query(`
            UPDATE gcr_main 
            SET points = json_set(
                points, 
                '$.breakdown.referrals', 
                0
            )
            WHERE points IS NOT NULL 
            AND json_extract(points, '$.breakdown') IS NOT NULL
            AND json_extract(points, '$.breakdown.referrals') IS NULL
        `)

        // Add referralInfo field for existing records
        await queryRunner.query(`
            UPDATE gcr_main 
            SET referralInfo = json_object(
                'totalReferrals', 0,
                'referralCode', pubkey,
                'referrals', json_array()
            )
            WHERE referralInfo IS NULL
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Remove referrals field from points breakdown
        await queryRunner.query(`
            UPDATE gcr_main 
            SET points = json_remove(points, '$.breakdown.referrals')
            WHERE json_extract(points, '$.breakdown.referrals') IS NOT NULL
        `)

        // Remove referralInfo field
        await queryRunner.query(`
            UPDATE gcr_main 
            SET referralInfo = NULL
        `)
    }
}
