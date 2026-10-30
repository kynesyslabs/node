/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import Datasource from "src/model/datasource"
import { scheduleDigest, type ForkSchedule } from "./acceptedForkSchedule"

const ROW_ID = "current"

export async function readAcceptedSchedule(): Promise<ForkSchedule | null> {
    const ds = (await Datasource.getInstance()).getDataSource()
    const rows: { schedule: ForkSchedule | string }[] = await ds.query(
        `SELECT "schedule" FROM "accepted_fork_schedule" WHERE "id" = $1`,
        [ROW_ID],
    )
    if (rows.length === 0) return null
    const raw = rows[0].schedule
    return typeof raw === "string" ? (JSON.parse(raw) as ForkSchedule) : raw
}

export async function writeAcceptedSchedule(
    schedule: ForkSchedule,
    tip: number,
): Promise<void> {
    const ds = (await Datasource.getInstance()).getDataSource()
    await ds.query(
        `INSERT INTO "accepted_fork_schedule" ("id", "schedule", "digest", "accepted_at_tip", "accepted_at")
         VALUES ($1, $2::jsonb, $3, $4, now())
         ON CONFLICT ("id") DO UPDATE SET
             "schedule" = EXCLUDED."schedule",
             "digest" = EXCLUDED."digest",
             "accepted_at_tip" = EXCLUDED."accepted_at_tip",
             "accepted_at" = EXCLUDED."accepted_at"`,
        [ROW_ID, JSON.stringify(schedule), scheduleDigest(schedule), tip],
    )
}
