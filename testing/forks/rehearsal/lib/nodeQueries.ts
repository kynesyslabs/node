/**
 * Observation primitives for the rehearsal harness.
 *
 * Two surfaces:
 *  - HTTP RPC against `http://localhost:<port>` (`getLastBlockNumber`,
 *    `getNetworkInfo`, etc).
 *  - Postgres via the `pg` client against `localhost:<POSTGRES_HOST_PORT>`
 *    (set by `testing/devnet/.env` — defaults to 5432).
 *
 * The harness must NEVER touch the running node process. All assertions
 * about state go through one of these two surfaces — that's the only
 * fidelity guarantee that matches what an external operator sees.
 */

import { Client as PgClient } from "pg"

/** Stable mapping of node id → host RPC port. Mirrors docker-compose.yml. */
export const NODE_RPC_PORTS: Record<number, number> = {
    1: 53551,
    2: 53553,
    3: 53555,
    4: 53557,
    5: 53559,
}

/** Host port for Postgres (override via env to match POSTGRES_HOST_PORT). */
export const POSTGRES_HOST_PORT = Number(
    process.env.POSTGRES_HOST_PORT ?? "5432",
)

/** PG credentials (mirror testing/devnet/.env defaults). */
export const PG_USER = process.env.POSTGRES_USER ?? "demosuser"
export const PG_PASSWORD = process.env.POSTGRES_PASSWORD ?? "demospass"

/** Database name for a given node index. */
export function dbForNode(nodeId: number): string {
    return `node${nodeId}_db`
}

/**
 * Issues a `nodeCall` RPC. The devnet exposes a single HTTP endpoint
 * that dispatches by `params[0].message`.
 *
 * @returns The unwrapped `response.response` payload from the node.
 */
export async function rpcNodeCall<T = any>(
    nodeId: number,
    message: string,
    extraParams: Record<string, unknown> = {},
    timeoutMs = 5_000,
): Promise<T> {
    const port = NODE_RPC_PORTS[nodeId]
    if (!port) throw new Error(`Unknown node id: ${nodeId}`)
    const url = `http://localhost:${port}`
    const controller = new AbortController()
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs)
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                method: "nodeCall",
                params: [{ message, ...extraParams }],
            }),
            signal: controller.signal,
        })
        if (!res.ok) {
            throw new Error(
                `RPC ${message} on node-${nodeId} returned HTTP ${res.status}`,
            )
        }
        const body = (await res.json()) as { response?: { response?: T }; result?: { response?: T } }
        // The on-the-wire envelope wraps the handler's response under
        // `response.response`. Some clients see `result` instead — accept
        // both.
        const inner = body?.response?.response ?? body?.result?.response
        return inner as T
    } finally {
        clearTimeout(timeoutHandle)
    }
}

/** Fetches the latest block height a node has processed. */
export async function getLastBlockNumber(nodeId: number): Promise<number> {
    const r = await rpcNodeCall<number | { number?: number }>(
        nodeId,
        "getLastBlockNumber",
    )
    if (typeof r === "number") return r
    if (r && typeof r === "object" && typeof r.number === "number") {
        return r.number
    }
    // Fallback: getLastBlock and pull number.
    const block = await rpcNodeCall<{ number: number }>(
        nodeId,
        "getLastBlock",
    )
    return block?.number ?? 0
}

export interface NetworkInfoResp {
    forks?: {
        osDenomination?: {
            activationHeight: number | null
            activated: boolean
            currentHeight: number
        }
    }
}

/** Returns the parsed `getNetworkInfo` payload. */
export async function getNetworkInfo(
    nodeId: number,
): Promise<NetworkInfoResp> {
    return rpcNodeCall<NetworkInfoResp>(nodeId, "getNetworkInfo")
}

/** Returns the hash of a given block height (or null if not present). */
export async function getBlockHash(
    nodeId: number,
    height: number,
): Promise<string | null> {
    const block = await rpcNodeCall<{ hash?: string } | null>(
        nodeId,
        "getBlockByNumber",
        { number: height },
    ).catch(() => null)
    return block?.hash ?? null
}

/** Connects to Postgres for the named DB. Caller must call `.end()`. */
export async function connectPg(dbName: string): Promise<PgClient> {
    const client = new PgClient({
        host: "localhost",
        port: POSTGRES_HOST_PORT,
        user: PG_USER,
        password: PG_PASSWORD,
        database: dbName,
    })
    await client.connect()
    return client
}

/** Convenience: runs a single SQL query against `nodeN_db`. */
export async function query<T = Record<string, unknown>>(
    nodeId: number,
    sql: string,
    params: unknown[] = [],
): Promise<T[]> {
    const client = await connectPg(dbForNode(nodeId))
    try {
        const r = await client.query(sql, params)
        return r.rows as T[]
    } finally {
        await client.end()
    }
}

export interface ForkStateRow {
    fork_name: string
    applied: boolean
    applied_at_block: string | number
    applied_at: string
    pre_sum_dem: string
    post_sum_os: string
    gcr_v2_row_count: number | string
    legacy_row_count: number | string
    validators_row_count: number | string
    capped_count: number | string
    total_value_lost_os: string
}

/** Reads the `fork_state` row for `osDenomination`, or null if absent. */
export async function getForkStateRow(
    nodeId: number,
): Promise<ForkStateRow | null> {
    const rows = await query<ForkStateRow>(
        nodeId,
        "SELECT * FROM fork_state WHERE fork_name = $1",
        ["osDenomination"],
    )
    return rows[0] ?? null
}

/** Sums `gcr_main.balance` (bigint) for the given node. */
export async function sumGcrMain(nodeId: number): Promise<bigint> {
    const rows = await query<{ s: string | null }>(
        nodeId,
        "SELECT COALESCE(SUM(balance::numeric), 0)::text AS s FROM gcr_main",
    )
    return BigInt(rows[0]?.s ?? "0")
}

/** Sums `validators.staked_amount` (text) for the given node. */
export async function sumValidatorStakes(nodeId: number): Promise<bigint> {
    const rows = await query<{ s: string | null }>(
        nodeId,
        "SELECT COALESCE(SUM(staked_amount::numeric), 0)::text AS s FROM validators",
    )
    return BigInt(rows[0]?.s ?? "0")
}

/** Sums `global_change_registry.details.content.balance` (JSONB number). */
export async function sumLegacyGcr(nodeId: number): Promise<bigint> {
    const rows = await query<{ s: string | null }>(
        nodeId,
        "SELECT COALESCE(SUM((details->'content'->>'balance')::numeric), 0)::text AS s FROM global_change_registry",
    )
    return BigInt(rows[0]?.s ?? "0")
}

/** Total (DEM or OS depending on whether fork has fired). */
export async function sumAllBalances(nodeId: number): Promise<bigint> {
    const [a, b, c] = await Promise.all([
        sumGcrMain(nodeId),
        sumValidatorStakes(nodeId),
        sumLegacyGcr(nodeId),
    ])
    return a + b + c
}

/** Number of confirmed blocks in the chain (for sanity checks). */
export async function getBlockCount(nodeId: number): Promise<number> {
    const rows = await query<{ c: string }>(
        nodeId,
        "SELECT COUNT(*)::text AS c FROM blocks",
    )
    return Number(rows[0]?.c ?? "0")
}

/** Hash of the genesis block (number=0) from Postgres directly. */
export async function getGenesisHashFromDb(
    nodeId: number,
): Promise<string | null> {
    const rows = await query<{ hash: string }>(
        nodeId,
        "SELECT hash FROM blocks WHERE number = 0",
    )
    return rows[0]?.hash ?? null
}

/** Hash of an arbitrary block from Postgres directly. */
export async function getBlockHashFromDb(
    nodeId: number,
    height: number,
): Promise<string | null> {
    const rows = await query<{ hash: string }>(
        nodeId,
        "SELECT hash FROM blocks WHERE number = $1",
        [height],
    )
    return rows[0]?.hash ?? null
}

/**
 * Inserts a synthetic legacy GCR row with a chosen DEM balance. Used for
 * scenario 5 (cap policy) to seed an account whose post-fork OS value
 * exceeds LEGACY_NUMBER_CAP.
 *
 * The migration reads `details.content.balance` as a JS number, so the
 * value is bound here as a number (the legacy backend's actual data
 * shape).
 */
export async function seedLegacyGcrRow(
    nodeId: number,
    publicKey: string,
    balanceDem: number,
): Promise<void> {
    const details = JSON.stringify({
        content: {
            balance: balanceDem,
            identities: { [publicKey]: 1 },
        },
    })
    await query(
        nodeId,
        `INSERT INTO global_change_registry (public_key, details, extended)
         VALUES ($1, $2::jsonb, '{}'::jsonb)`,
        [publicKey, details],
    )
}

/** Drops and recreates a node's database. Used for scenario 2 (desync). */
export async function dropAndRecreateNodeDb(nodeId: number): Promise<void> {
    // We cannot drop a DB while connected to it — connect to `postgres`.
    const admin = new PgClient({
        host: "localhost",
        port: POSTGRES_HOST_PORT,
        user: PG_USER,
        password: PG_PASSWORD,
        database: "postgres",
    })
    await admin.connect()
    try {
        const dbName = dbForNode(nodeId)
        // Force-disconnect any clients (otherwise DROP DATABASE blocks).
        await admin.query(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
             WHERE datname = $1 AND pid <> pg_backend_pid()`,
            [dbName],
        )
        await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`)
        await admin.query(`CREATE DATABASE "${dbName}" OWNER ${PG_USER}`)
    } finally {
        await admin.end()
    }
}
