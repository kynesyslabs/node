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
 * Bun's fetch defaults to `keepalive: true`, which reuses TCP sockets
 * across calls. The devnet node's HTTP server (raw `Bun.serve` with
 * default keep-alive timeout) closes idle sockets faster than the
 * harness's poll cadence reuses them, so a poll that arrives just as
 * the server is closing the socket sees `socket connection was closed
 * unexpectedly`. We disable keepalive on every RPC and retry once on
 * the socket-close window to make polling robust.
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
    const body = JSON.stringify({
        method: "nodeCall",
        params: [{ message, ...extraParams }],
    })

    const attempt = async (): Promise<T> => {
        const controller = new AbortController()
        const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs)
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    // Belt-and-braces: even when Bun honours
                    // `keepalive: false` we ask the server to close on
                    // its side too (Bun issue #14538: keepalive is not
                    // always respected by the fetch impl).
                    Connection: "close",
                },
                body,
                signal: controller.signal,
                // Bun-specific: opt out of the connection-pool reuse.
                keepalive: false,
            } as RequestInit)
            if (!res.ok) {
                throw new Error(
                    `RPC ${message} on node-${nodeId} returned HTTP ${res.status}`,
                )
            }
            const parsed = (await res.json()) as {
                response?: T | { response?: T }
                result?: number | { response?: T }
            }
            // The devnet's nodeCall envelope is
            //   { result: <httpStatus>, response: <handlerPayload>, ... }
            // — `response` IS the payload. Older internal clients
            // sometimes wrap the payload one level deeper; we accept
            // both and unwrap iff the inner has a `.response` key. The
            // pre-existing reader assumed the always-doubly-wrapped
            // shape and silently returned `undefined` against the live
            // node, which is why `getLastBlockNumber` reported 0 and
            // every height poll timed out (Run 3 mis-diagnosed this as
            // a pure socket-close flake; it is BOTH).
            const r = parsed?.response
            if (
                r !== null &&
                typeof r === "object" &&
                "response" in (r as object)
            ) {
                return (r as { response: T }).response
            }
            return r as T
        } finally {
            clearTimeout(timeoutHandle)
        }
    }

    // Retry on transient socket-close: each retry uses a fresh attempt
    // (no shared socket / controller). Total of 4 tries with linear
    // backoff is enough to clear the half-closed-pool window we hit on
    // localhost devnet — see commit message for the upstream Bun bug.
    let lastErr: unknown
    const backoffsMs = [0, 200, 400, 800]
    for (const wait of backoffsMs) {
        if (wait > 0) {
            await new Promise(r => setTimeout(r, wait))
        }
        try {
            return await attempt()
        } catch (e) {
            lastErr = e
            if (!isTransientSocketError(e)) throw e
        }
    }
    throw lastErr
}

/**
 * True for the Bun-fetch errors we observed when the node's HTTP server
 * closes a keep-alive socket mid-request. We match on message text
 * because Bun does not expose a stable error code/cause chain for
 * these.
 */
function isTransientSocketError(e: unknown): boolean {
    if (!(e instanceof Error)) return false
    const msg = e.message.toLowerCase()
    return (
        msg.includes("socket connection was closed unexpectedly") ||
        msg.includes("socket hang up") ||
        msg.includes("connection closed") ||
        msg.includes("econnreset") ||
        msg.includes("fetch failed")
    )
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
    /**
     * Pg-driver-hydrated value: `TIMESTAMPTZ` is parsed to a JS `Date` by
     * the default `pg` type parser, but appears as an ISO string when
     * cast to text in SQL (e.g. for forensics tooling). Both shapes are
     * accepted; consumers should coerce to a stable representation
     * before comparing — see scenario 8's `toEpochMs` helper.
     */
    applied_at: string | Date
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

/**
 * Returns the DEM balance of a previously-seeded legacy GCR row, or
 * null if no row with that `public_key` exists yet on this node.
 *
 * Read-back of {@link seedLegacyGcrRow} writes; used by scenario 5 to
 * deterministically confirm the seed has been replicated to every node's
 * `global_change_registry` BEFORE the network is allowed to cross the
 * fork-activation height. Without this verify-after-insert step, the
 * migration could read an empty legacy GCR and never exercise the cap
 * path (the symptom diagnosed in Run 4).
 */
export async function getLegacyGcrBalance(
    nodeId: number,
    publicKey: string,
): Promise<number | null> {
    const rows = await query<{ balance: string | number | null }>(
        nodeId,
        `SELECT (details->'content'->>'balance')::numeric AS balance
         FROM global_change_registry
         WHERE public_key = $1`,
        [publicKey],
    )
    if (rows.length === 0) return null
    const raw = rows[0]?.balance
    if (raw === null || raw === undefined) return null
    return Number(raw)
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
