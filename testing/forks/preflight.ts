/**
 * Pre-flight check script for the `osDenomination` fork activation —
 * runs every prerequisite from `decimal_planning/RUNBOOK_FORK_ACTIVATION.md`
 * §2. Read-only; all checks run before exit (non-zero on any FAIL).
 *
 * Usage: `bun run preflight:fork [-- --rpc-url http://127.0.0.1:53551]`
 *
 * PG env vars match `src/config/loader.ts` (PG_HOST/PORT/USER/PASSWORD/
 * DATABASE); defaults mirror `src/config/defaults.ts`. TypeORM migrations
 * table is the default `migrations` (no override in datasource). No
 * `bun run build` script exists in package.json; the closest artifact is
 * `dist/tsconfig.tsbuildinfo` (per tsconfig outDir) — we use its mtime.
 */

import { readFileSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { Client as PgClient } from "pg"

type Status = "PASS" | "FAIL" | "SKIP"
interface CheckResult { name: string; status: Status; detail: string }
const REPO_ROOT = resolve(import.meta.dir, "..", "..")
const results: CheckResult[] = []
const rec = (name: string, status: Status, detail: string): void => { results.push({ name, status, detail }) }

const PG_CFG = {
    host: process.env.PG_HOST ?? "localhost",
    port: Number(process.env.PG_PORT ?? "5332"),
    user: process.env.PG_USER ?? "demosuser",
    password: process.env.PG_PASSWORD ?? "demospassword",
    database: process.env.PG_DATABASE ?? "demos",
}
const REQUIRED_MIGRATIONS = ["WidenFeeColumnsToBigint", "CreateForkStateTable", "WidenGcrMainBalanceToNumeric"]
const MIN_SDK = "3.1.0"
const FEE_COLS = ["networkFee", "rpcFee", "additionalFee"]

function parseRpcFlag(): string | null {
    const i = process.argv.indexOf("--rpc-url")
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null
}

function compareSemver(a: string, b: string): number {
    const pa = a.replace(/^[\^~]/, "").split(".").map(n => parseInt(n, 10))
    const pb = b.split(".").map(n => parseInt(n, 10))
    for (let i = 0; i < 3; i++) {
        const x = pa[i] ?? 0
        const y = pb[i] ?? 0
        if (x !== y) return x - y
    }
    return 0
}

function checkBuild(): void {
    for (const rel of ["dist/tsconfig.tsbuildinfo", "dist/index.js"]) {
        try {
            const s = statSync(resolve(REPO_ROOT, rel))
            const ageDays = (Date.now() - s.mtimeMs) / 86_400_000
            if (ageDays <= 7) {
                rec("Node binary build", "PASS", `${rel} (built ${s.mtime.toISOString().slice(0, 10)})`)
            } else {
                rec("Node binary build", "FAIL", `${rel} is ${ageDays.toFixed(1)}d old; run \`bun run build\``)
            }
            return
        } catch { /* try next candidate */ }
    }
    rec("Node binary build", "FAIL", "build not found or stale, run `bun run build`")
}

function checkSdkVersion(pkg: any): void {
    const dep = pkg?.dependencies?.["@kynesyslabs/demosdk"]
    if (!dep) return rec("SDK version", "FAIL", "@kynesyslabs/demosdk missing from dependencies")
    if (compareSemver(dep, MIN_SDK) >= 0) rec("SDK version", "PASS", `${dep} (>= ${MIN_SDK} required)`)
    else rec("SDK version", "FAIL", `${dep} < ${MIN_SDK}; run \`bun run upgrade_sdk\``)
}

function checkGenesis(): void {
    const path = resolve(REPO_ROOT, "data/genesis.json")
    let g: any
    try { g = JSON.parse(readFileSync(path, "utf8")) } catch (e) {
        return rec("Genesis file", "FAIL", `read/parse error: ${(e as Error).message}`)
    }
    const missing = ["properties", "mutables", "balances"].filter(k => !(k in g))
    if (missing.length > 0) return rec("Genesis file", "FAIL", `missing top-level keys: ${missing.join(", ")}`)
    const balCount = Array.isArray(g.balances) ? g.balances.length : 0
    const ah = g?.forks?.osDenomination?.activationHeight
    const ahDetail = typeof ah === "number" ? `activationHeight=${ah}` : "no activation height configured (expected pre-fork)"
    rec("Genesis file", "PASS", `${balCount} balances, ${ahDetail}`)
}

async function checkPostgres(): Promise<void> {
    const client = new PgClient(PG_CFG)
    const dsn = `${PG_CFG.user}@${PG_CFG.host}:${PG_CFG.port}/${PG_CFG.database}`
    try { await client.connect() } catch (e) {
        const err = e as Error & { code?: string }
        rec("PostgreSQL connectivity", "FAIL", `${dsn}: ${err.message || err.code || "connection refused"}`)
        for (const n of ["gcr_main.balance type", "Migrations applied", "fork_state empty", "Fee columns bigint"]) {
            rec(n, "SKIP", "Postgres unreachable")
        }
        return
    }
    try {
        await client.query("SELECT 1")
        rec("PostgreSQL connectivity", "PASS", `connected to ${dsn}`)

        // gcr_main.balance type.
        const gcr = await client.query<{ data_type: string }>(
            "SELECT data_type FROM information_schema.columns WHERE table_name='gcr_main' AND column_name='balance'",
        )
        if (gcr.rows.length === 0) rec("gcr_main.balance type", "FAIL", "gcr_main table or balance column missing")
        else if (gcr.rows[0].data_type !== "numeric") {
            rec("gcr_main.balance type", "FAIL", `${gcr.rows[0].data_type} (WidenGcrMainBalanceToNumeric migration not applied)`)
        } else rec("gcr_main.balance type", "PASS", "numeric")

        // Migrations applied.
        try {
            const m = await client.query<{ name: string }>("SELECT name FROM migrations")
            const missing = REQUIRED_MIGRATIONS.filter(req => !m.rows.some(r => r.name.startsWith(req)))
            if (missing.length === 0) rec("Migrations applied", "PASS", `${REQUIRED_MIGRATIONS.length}/${REQUIRED_MIGRATIONS.length}`)
            else rec("Migrations applied", "FAIL", `missing: ${missing.join(", ")}`)
        } catch (e) {
            rec("Migrations applied", "FAIL", `cannot read \`migrations\` table: ${(e as Error).message}`)
        }

        // fork_state empty.
        try {
            const fs = await client.query<{ count: string }>(
                "SELECT COUNT(*)::text AS count FROM fork_state WHERE fork_name='osDenomination'",
            )
            const n = Number(fs.rows[0]?.count ?? "0")
            if (n === 0) rec("fork_state empty", "PASS", "0 rows for osDenomination (pre-fork state)")
            else rec("fork_state empty", "FAIL", `${n} row(s) — DB has crossed (or partially crossed) the fork; do NOT proceed`)
        } catch (e) {
            rec("fork_state empty", "FAIL", `query error: ${(e as Error).message}`)
        }

        // Fee columns bigint.
        const fee = await client.query<{ column_name: string; data_type: string }>(
            `SELECT column_name, data_type FROM information_schema.columns
             WHERE table_name='transactions' AND column_name IN ('networkFee','rpcFee','additionalFee')`,
        )
        const found = new Map(fee.rows.map(r => [r.column_name, r.data_type]))
        const bad = FEE_COLS.filter(c => found.get(c) !== "bigint")
        if (bad.length === 0) rec("Fee columns bigint", "PASS", "all bigint (networkFee, rpcFee, additionalFee)")
        else {
            const detail = bad.map(c => `${c}=${found.get(c) ?? "missing"}`).join(", ")
            rec("Fee columns bigint", "FAIL", `non-bigint: ${detail} — WidenFeeColumnsToBigint migration not applied`)
        }
    } finally {
        await client.end().catch(() => undefined)
    }
}

async function checkRpc(rpcUrl: string | null): Promise<void> {
    if (!rpcUrl) return rec("getNetworkInfo RPC", "SKIP", "no --rpc-url flag")
    try {
        const res = await fetch(rpcUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json", Connection: "close" },
            body: JSON.stringify({ method: "nodeCall", params: [{ message: "getNetworkInfo" }] }),
        })
        const text = await res.text()
        const parsed = JSON.parse(text)
        const ni = parsed?.response?.response ?? parsed?.response ?? parsed
        if (ni?.forks?.osDenomination) {
            const ah = ni.forks.osDenomination.activationHeight ?? "null"
            rec("getNetworkInfo RPC", "PASS", `forks.osDenomination present (activationHeight=${ah})`)
        } else {
            rec("getNetworkInfo RPC", "FAIL", `unexpected shape; got: ${text.slice(0, 200)}`)
        }
    } catch (e) {
        rec("getNetworkInfo RPC", "FAIL", (e as Error).message)
    }
}

async function main(): Promise<void> {
    console.log("=== Pre-flight check: osDenomination fork ===")
    let pkg: any = {}
    try { pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) }
    catch (e) { rec("package.json", "FAIL", (e as Error).message) }

    checkBuild()
    checkSdkVersion(pkg)
    checkGenesis()
    await checkPostgres()
    await checkRpc(parseRpcFlag())

    for (const r of results) console.log(`[${r.status}] ${r.name}: ${r.detail}`)
    const total = results.length
    const passed = results.filter(r => r.status === "PASS").length
    const failed = results.filter(r => r.status === "FAIL").length
    const skipped = results.filter(r => r.status === "SKIP").length
    const tail = failed === 0 ? " Validator ready for fork activation." : ` ${failed} FAIL — fix before proceeding.`
    console.log(`\n${passed}/${total} checks passed${skipped > 0 ? ` (${skipped} skipped)` : ""}.${tail}`)
    console.log(`PG config used: ${PG_CFG.user}@${PG_CFG.host}:${PG_CFG.port}/${PG_CFG.database}`)
    process.exit(failed > 0 ? 1 : 0)
}

void main()
