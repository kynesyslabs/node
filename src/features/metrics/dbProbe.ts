/**
 * Postgres liveness for the DbDown alert (monitoring/prometheus/alerts/node-health.yml).
 *
 * Every DB_PROBE_INTERVAL_MS the node runs a cheap query through its own
 * connection pool and reports 1 when it answered within DB_PROBE_TIMEOUT_MS,
 * 0 otherwise. It runs on its own timer, never on the consensus path, and a
 * tick always ends within the timeout whatever the database does.
 *
 * At most one probe query is in flight. When a tick times out it aborts the
 * probe's signal, and the probe gives up its connection (pingDatabase in
 * MetricsCollector.ts ends its pool client instead of returning it) and then
 * settles. Until it has settled, ticks report 0 without starting another
 * query, so a database that never answers ties up one pool connection at
 * most. The first tick after that probes on a fresh connection, so the result
 * goes back to 1 once Postgres answers again, even when the timed-out query
 * never gets an answer (a half-open connection).
 *
 * stop() is final: it aborts a query still in flight, and a stopped probe
 * reports nothing more, so it cannot overwrite its replacement's result.
 *
 * @module features/metrics
 */

/** Probe period. The DbDown `for:` (1m) is four of these. */
export const DB_PROBE_INTERVAL_MS = 15_000
/** Longer than any healthy `SELECT 1`, shorter than the interval. */
export const DB_PROBE_TIMEOUT_MS = 5_000

export interface DbProbeOptions {
    /**
     * The query; resolves when Postgres answered. `signal` aborts when the
     * tick times out or the probe stops: the probe then gives up its
     * connection and settles, without waiting for the query.
     */
    probe: (signal: AbortSignal) => Promise<unknown>
    /** Called once per tick: up, and the probe's duration in seconds when it succeeded. */
    report: (up: 0 | 1, seconds: number | null) => void
    /**
     * Called when the result changes, on a first result of 0, and when the
     * reason of a 0 differs from the last one passed here.
     */
    onChange?: (up: 0 | 1, reason: string | null) => void
    intervalMs?: number
    timeoutMs?: number
}

function reasonOf(error: unknown): string {
    if (error instanceof Error && error.message) return error.message
    const code = (error as { code?: unknown } | null)?.code
    return code ? String(code) : String(error)
}

export class DbProbe {
    private timer: ReturnType<typeof setInterval> | null = null
    private inFlight: Promise<unknown> | null = null
    private controller: AbortController | null = null
    private stopped = false
    private lastUp: 0 | 1 | null = null
    private lastReason: string | null = null
    private readonly intervalMs: number
    private readonly timeoutMs: number
    private readonly noAnswer: string

    constructor(private readonly options: DbProbeOptions) {
        this.intervalMs = options.intervalMs ?? DB_PROBE_INTERVAL_MS
        this.timeoutMs = options.timeoutMs ?? DB_PROBE_TIMEOUT_MS
        this.noAnswer = `no answer within ${this.timeoutMs} ms`
    }

    public start(): void {
        if (this.timer || this.stopped) return
        void this.tick()
        this.timer = setInterval(() => void this.tick(), this.intervalMs)
        this.timer.unref?.()
    }

    /** Final: aborts a query still in flight; nothing is reported after it. */
    public stop(): void {
        this.stopped = true
        if (this.timer) clearInterval(this.timer)
        this.timer = null
        this.controller?.abort(new Error("the probe was stopped"))
    }

    /** One probe. Never rejects, and resolves within the timeout. */
    public async tick(): Promise<void> {
        if (this.stopped) return
        if (this.inFlight) {
            // Still the timed-out probe: same reason, so no new log line.
            this.record(0, null, this.noAnswer)
            return
        }

        const started = performance.now()
        const controller = new AbortController()
        const query = Promise.resolve().then(() =>
            this.options.probe(controller.signal),
        )
        this.inFlight = query
        this.controller = controller
        // An aborted probe settles once it has given up its connection; only
        // then may the next tick start a query.
        const settle = () => {
            if (this.inFlight !== query) return
            this.inFlight = null
            this.controller = null
        }
        query.then(settle, settle)

        let timer: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<"timeout">(resolve => {
            timer = setTimeout(() => resolve("timeout"), this.timeoutMs)
        })
        try {
            const outcome = await Promise.race([
                query.then(() => "ok" as const),
                timeout,
            ])
            if (outcome === "ok") {
                this.record(1, (performance.now() - started) / 1000, null)
            } else {
                controller.abort(new Error(this.noAnswer))
                this.record(0, null, this.noAnswer)
            }
        } catch (error) {
            this.record(0, null, reasonOf(error))
        } finally {
            clearTimeout(timer)
        }
    }

    private record(
        up: 0 | 1,
        seconds: number | null,
        reason: string | null,
    ): void {
        // A stopped probe may have been replaced: its late result is stale.
        if (this.stopped) return
        this.options.report(up, seconds)
        // A 0 is logged when it follows a 1 or nothing, or has a new reason.
        const changed =
            up === 0
                ? this.lastUp !== 0 || reason !== this.lastReason
                : this.lastUp === 0
        this.lastUp = up
        this.lastReason = up === 0 ? reason : null
        if (changed) this.options.onChange?.(up, reason)
    }
}
