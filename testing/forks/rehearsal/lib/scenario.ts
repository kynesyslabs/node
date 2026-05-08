/**
 * Scenario harness — wraps an async scenario function with timing,
 * pass/fail reporting, and consistent setup/teardown around the devnet.
 *
 * Each scenario is independent: it brings the devnet up from a fully
 * wiped state and tears it down at the end. The `--keep-state` flag
 * suppresses teardown so the operator can attach `psql` / `docker logs`
 * for forensics on a failure.
 */

import {
    downHard,
    restoreProductionGenesis,
    banner,
} from "./devnetControl"

export interface ScenarioContext {
    /** Honoured at the end: true → leave devnet running for inspection. */
    keepState: boolean
    /** Logged for triage; appended to result summary. */
    notes: string[]
}

export interface ScenarioResult {
    name: string
    status: "pass" | "fail"
    durationMs: number
    error?: string
    notes: string[]
}

export type ScenarioFn = (ctx: ScenarioContext) => Promise<void>

/**
 * Runs a scenario with consistent lifecycle handling.
 *
 * Lifecycle:
 *  1. Print banner.
 *  2. (Always) `docker compose down -v` for a clean slate. Even if a
 *     previous run left state, we do not chain across scenarios — the
 *     spec is explicit about per-scenario isolation.
 *  3. Restore production genesis (in case a previous scenario crashed
 *     mid-flight and left a rehearsal genesis staged).
 *  4. Run the scenario function.
 *  5. Restore production genesis again on the way out.
 *  6. (Unless --keep-state) tear down again.
 */
export async function runScenario(
    name: string,
    fn: ScenarioFn,
): Promise<ScenarioResult> {
    const keepState = process.argv.includes("--keep-state")
    const ctx: ScenarioContext = { keepState, notes: [] }
    banner(`SCENARIO: ${name}${keepState ? "  (keep-state)" : ""}`)
    const start = Date.now()

    // Pre-clean
    try {
        downHard({ profiles: ["rehearsal"] })
    } catch {
        /* tolerate first-run when nothing to bring down */
    }
    restoreProductionGenesis()

    let error: string | undefined
    let status: "pass" | "fail" = "pass"
    try {
        await fn(ctx)
    } catch (e) {
        status = "fail"
        error = e instanceof Error ? e.message : String(e)
        process.stderr.write(`\n[FAIL] ${name}: ${error}\n`)
        if (e instanceof Error && e.stack) {
            process.stderr.write(`${e.stack}\n`)
        }
    } finally {
        // Always restore production genesis before exit, even on failure.
        restoreProductionGenesis()
        if (!keepState) {
            try {
                downHard({ profiles: ["rehearsal"] })
            } catch {
                /* swallow — primary failure already recorded */
            }
        }
    }

    const durationMs = Date.now() - start
    const result: ScenarioResult = {
        name,
        status,
        durationMs,
        error,
        notes: ctx.notes,
    }
    banner(
        `RESULT: ${name} → ${status.toUpperCase()} in ${(durationMs / 1000).toFixed(1)}s`,
    )
    return result
}

/**
 * CLI entrypoint: runs the scenario fn and exits with status 0/1
 * depending on result. This is what each `scenarios/NN-foo.ts` file
 * calls at module bottom so it can be `bun run` directly.
 */
export async function runScenarioCli(
    name: string,
    fn: ScenarioFn,
): Promise<never> {
    const result = await runScenario(name, fn)
    if (result.status === "fail") {
        process.stderr.write(
            `\n=== FAILURE ===\n${result.error ?? "(no error message)"}\n`,
        )
        process.exit(1)
    }
    process.exit(0)
}
