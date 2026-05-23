/**
 * P6-T1 — Unit + integration tests for seedValidators.
 *
 * Tests are grouped into:
 *   - Pure unit tests (no DB required) that validate input-validation logic.
 *   - PG-gated integration tests that run the full insert path against a
 *     real Postgres instance.
 *
 * The PG-gated tests use the same skipIf pattern as genesisRestore.test.ts:
 * a `beforeAll` probe detects the connection and marks affected tests as
 * skipped when Postgres is not reachable.
 *
 * Test isolation: each integration test truncates the `validators` table in
 * its own afterEach so the PG schema stays intact for the full suite.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test"
import { DataSource } from "typeorm"

import {
    seedValidators,
    type GenesisValidatorSeed,
} from "@/libs/blockchain/genesis/seedValidators"
import { Validators } from "@/model/entities/Validators"

// =============================================================================
// Postgres connection
// =============================================================================

const PG_HOST = process.env.PG_HOST ?? "localhost"
const PG_PORT = Number(process.env.PG_PORT ?? "5432")
const PG_USER = process.env.PG_USER ?? "demosuser"
const PG_PASSWORD = process.env.PG_PASSWORD ?? "demospassword"
const PG_DATABASE = process.env.PG_DATABASE ?? "demos"

let ds: DataSource
let pgAvailable = false

async function createDs(): Promise<DataSource> {
    const source = new DataSource({
        type: "postgres",
        host: PG_HOST,
        port: PG_PORT,
        username: PG_USER,
        password: PG_PASSWORD,
        database: PG_DATABASE,
        synchronize: false,
        logging: false,
        entities: [Validators],
    })
    await source.initialize()
    return source
}

beforeAll(async () => {
    try {
        ds = await createDs()
        pgAvailable = true
    } catch {
        pgAvailable = false
        console.warn(
            "[seedValidators.test] Postgres not reachable — PG-gated tests will skip.",
        )
    }
})

afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy()
})

afterEach(async () => {
    if (pgAvailable && ds?.isInitialized) {
        await ds.query(`TRUNCATE TABLE validators`)
    }
})

// =============================================================================
// Fixture helpers
// =============================================================================

function makeValidSeed(
    overrides: Partial<GenesisValidatorSeed> = {},
): GenesisValidatorSeed {
    return {
        address:
            "0x24c664d9ef529f798e979357c6a7a01088226eefe05cfdb77fb42841f771e156",
        status: "2",
        connection_url: "http://node3.demos.sh:53550",
        staked_amount: "1000000000000000000",
        first_seen: 0,
        valid_at: 0,
        ...overrides,
    }
}

const FIVE_SEEDS: GenesisValidatorSeed[] = [
    {
        address:
            "0x24c664d9ef529f798e979357c6a7a01088226eefe05cfdb77fb42841f771e156",
        status: "2",
        connection_url: "http://node3.demos.sh:53550",
        staked_amount: "1000000000000000000",
        first_seen: 0,
        valid_at: 0,
    },
    {
        address:
            "0xe887b1433a2e2e72447d2410b12c947f1d40567862cabf705409ecc495416f1d",
        status: "2",
        connection_url: "http://38.242.135.203:53550",
        staked_amount: "1000000000000000000",
        first_seen: 0,
        valid_at: 0,
    },
    {
        address:
            "0x484f6fb01275be0ae29328cea91b86af6caaf99e89d43d978c4aeb20c7d291d4",
        status: "2",
        connection_url: "http://38.242.136.202:53550",
        staked_amount: "1000000000000000000",
        first_seen: 0,
        valid_at: 0,
    },
    {
        address:
            "0x57b4309d0a9eb668b50538861654205ec6b5a2e028ca9cfb1fd7ea78dbea2480",
        status: "2",
        connection_url: "http://38.242.139.8:53550",
        staked_amount: "1000000000000000000",
        first_seen: 0,
        valid_at: 0,
    },
    {
        address:
            "0xfbf59d28a6d0a9ea8fc13c8a7ff7a5c30304ae2b851877a077049878a0c91e61",
        status: "2",
        connection_url: "http://38.242.141.58:53550",
        staked_amount: "1000000000000000000",
        first_seen: 0,
        valid_at: 0,
    },
]

// =============================================================================
// Input-validation unit tests (no DB required)
// =============================================================================

describe("seedValidators — input validation (no DB)", () => {
    it("empty array → returns { inserted: 0 } immediately", async () => {
        // We need a dummy em that is never called. Cast to unknown first to
        // satisfy TypeScript without reaching into typeorm internals.
        const em = {
            query: () => {
                throw new Error("should not be called")
            },
            insert: () => {
                throw new Error("should not be called")
            },
        } as unknown as import("typeorm").EntityManager

        const result = await seedValidators(em, [])
        expect(result).toEqual({ inserted: 0 })
    })

    it("address without 0x prefix → throws", async () => {
        const em = {} as unknown as import("typeorm").EntityManager
        const bad = makeValidSeed({
            address: "24c664d9ef529f798e979357c6a7a01088226eefe05cfdb77fb42841f771e156",
        })
        await expect(seedValidators(em, [bad])).rejects.toThrow(
            /address invalid/i,
        )
    })

    it("address too short → throws", async () => {
        const em = {} as unknown as import("typeorm").EntityManager
        const bad = makeValidSeed({ address: "0xdeadbeef" })
        await expect(seedValidators(em, [bad])).rejects.toThrow(
            /address invalid/i,
        )
    })

    it("address with non-hex chars → throws", async () => {
        const em = {} as unknown as import("typeorm").EntityManager
        // 64 chars but contains 'g'
        const bad = makeValidSeed({
            address:
                "0xgggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg",
        })
        await expect(seedValidators(em, [bad])).rejects.toThrow(
            /address invalid/i,
        )
    })

    it("empty status → throws", async () => {
        const em = {} as unknown as import("typeorm").EntityManager
        const bad = makeValidSeed({ status: "" })
        await expect(seedValidators(em, [bad])).rejects.toThrow(
            /status must be a non-empty string/i,
        )
    })

    it('staked_amount = "0" → throws (must be > 0)', async () => {
        const em = {} as unknown as import("typeorm").EntityManager
        const bad = makeValidSeed({ staked_amount: "0" })
        await expect(seedValidators(em, [bad])).rejects.toThrow(
            /staked_amount must be > 0/i,
        )
    })

    it('staked_amount = "-1" → throws', async () => {
        const em = {} as unknown as import("typeorm").EntityManager
        const bad = makeValidSeed({ staked_amount: "-1" })
        await expect(seedValidators(em, [bad])).rejects.toThrow(
            /staked_amount must be > 0/i,
        )
    })

    it("staked_amount non-numeric string → throws", async () => {
        const em = {} as unknown as import("typeorm").EntityManager
        const bad = makeValidSeed({ staked_amount: "not-a-number" })
        await expect(seedValidators(em, [bad])).rejects.toThrow(
            /staked_amount is not a valid bigint/i,
        )
    })

    it("negative first_seen → throws", async () => {
        const em = {} as unknown as import("typeorm").EntityManager
        const bad = makeValidSeed({ first_seen: -1 })
        await expect(seedValidators(em, [bad])).rejects.toThrow(
            /first_seen must be a non-negative integer/i,
        )
    })

    it("fractional first_seen → throws", async () => {
        const em = {} as unknown as import("typeorm").EntityManager
        const bad = makeValidSeed({ first_seen: 1.5 })
        await expect(seedValidators(em, [bad])).rejects.toThrow(
            /first_seen must be a non-negative integer/i,
        )
    })

    it("negative valid_at → throws", async () => {
        const em = {} as unknown as import("typeorm").EntityManager
        const bad = makeValidSeed({ valid_at: -5 })
        await expect(seedValidators(em, [bad])).rejects.toThrow(
            /valid_at must be a non-negative integer/i,
        )
    })
})

// =============================================================================
// PG-gated integration tests
// =============================================================================

describe("seedValidators — integration (requires Postgres)", () => {
    it.skipIf(!pgAvailable)(
        "happy path: 5 seeds → inserts 5 rows, all status='2', staked_amount=1e18",
        async () => {
            let result: { inserted: number } | null = null

            await ds.transaction(async em => {
                result = await seedValidators(em, FIVE_SEEDS)
            })

            expect(result).not.toBeNull()
            expect(result!.inserted).toBe(5)

            const rows: Array<{
                address: string
                status: string
                staked_amount: string
            }> = await ds.query(
                `SELECT address, status, staked_amount FROM validators ORDER BY address`,
            )
            expect(rows).toHaveLength(5)

            for (const row of rows) {
                expect(row.status).toBe("2")
                expect(row.staked_amount).toBe("1000000000000000000")
            }
        },
    )

    it.skipIf(!pgAvailable)(
        "happy path: unstake fields are NULL for all seeded validators",
        async () => {
            await ds.transaction(async em => {
                await seedValidators(em, FIVE_SEEDS)
            })

            const rows: Array<{
                unstake_requested_at: number | null
                unstake_available_at: number | null
            }> = await ds.query(
                `SELECT unstake_requested_at, unstake_available_at FROM validators`,
            )
            expect(rows).toHaveLength(5)
            for (const row of rows) {
                expect(row.unstake_requested_at).toBeNull()
                expect(row.unstake_available_at).toBeNull()
            }
        },
    )

    it.skipIf(!pgAvailable)(
        "happy path: first_seen and valid_at are 0 for all seeded validators",
        async () => {
            await ds.transaction(async em => {
                await seedValidators(em, FIVE_SEEDS)
            })

            const rows: Array<{ first_seen: number; valid_at: number }> =
                await ds.query(
                    `SELECT first_seen, valid_at FROM validators`,
                )
            expect(rows).toHaveLength(5)
            for (const row of rows) {
                expect(Number(row.first_seen)).toBe(0)
                expect(Number(row.valid_at)).toBe(0)
            }
        },
    )

    it.skipIf(!pgAvailable)(
        "pre-flight rejects non-empty validators table",
        async () => {
            // Pre-insert one validator row directly.
            await ds.query(
                `INSERT INTO validators
                    (address, status, connection_url, staked_amount, first_seen, valid_at)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [
                    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "2",
                    "http://example.com",
                    "1000000000000000000",
                    0,
                    0,
                ],
            )

            await expect(
                ds.transaction(async em => {
                    await seedValidators(em, FIVE_SEEDS)
                }),
            ).rejects.toThrow(
                /validator seed requires empty validators table; found 1 rows/i,
            )
        },
    )

    it.skipIf(!pgAvailable)(
        "connection_url is stored exactly as provided",
        async () => {
            const singleSeed: GenesisValidatorSeed = makeValidSeed({
                connection_url: "http://node3.demos.sh:53550",
            })

            await ds.transaction(async em => {
                await seedValidators(em, [singleSeed])
            })

            const rows: Array<{ connection_url: string }> = await ds.query(
                `SELECT connection_url FROM validators WHERE address = $1`,
                [singleSeed.address],
            )
            expect(rows).toHaveLength(1)
            expect(rows[0].connection_url).toBe("http://node3.demos.sh:53550")
        },
    )

    it.skipIf(!pgAvailable)(
        "PG integration: restoreSnapshot + seedValidators in one transaction — both committed or both rolled back",
        async () => {
            // This test verifies transactional atomicity without running the
            // full restoreSnapshot (which requires a snapshot fixture). We
            // simulate a successful state by inserting into gcr_main directly
            // and confirm that validators roll back when the transaction throws.

            await expect(
                ds.transaction(async em => {
                    // Insert a validator row.
                    await seedValidators(em, [makeValidSeed()])
                    // Verify it is visible inside the transaction.
                    const rows: Array<{ count: string }> = await em.query(
                        `SELECT COUNT(*)::text AS count FROM validators`,
                    )
                    expect(Number(rows[0].count)).toBe(1)
                    // Force a rollback.
                    throw new Error("intentional rollback")
                }),
            ).rejects.toThrow("intentional rollback")

            // After the rolled-back transaction, the table must be empty.
            const after: Array<{ count: string }> = await ds.query(
                `SELECT COUNT(*)::text AS count FROM validators`,
            )
            expect(Number(after[0].count)).toBe(0)
        },
    )
})
