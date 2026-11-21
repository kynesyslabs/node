/**
 * Postgres liveness for the DbDown alert (monitoring/prometheus/alerts/node-health.yml).
 *
 * Every DB_PROBE_INTERVAL_MS the node runs a cheap query through its own
 * connection pool and reports 1 when it answered within DB_PROBE_TIMEOUT_MS,
 * 0 otherwise. It runs on its own timer, never on the consensus path, and a
 * tick always ends within the timeout whatever the database does.
 *
 * At most one probe query is in flight. If the previous one is still
 * unanswered when the next tick comes, that tick reports 0 without queueing
 * another query, so a database that never answers ties up one pool
 * connection at most.
 *
 * @module features/metrics
 */

/** Probe period. The DbDown `for:` (1m) is four of these. */
export const DB_PROBE_INTERVAL_MS = 15_000
/** Longer than any healthy `SELECT 1`, shorter than the interval. */
export const DB_PROBE_TIMEOUT_MS = 5_000

export interface DbProbeOptions {
    /** The query; resolves when Postgres answered. */
    probe: () => Promise<unknown>
    /** Called once per tick: up, and the probe's duration in seconds when it succeeded. */
    report: (up: 0 | 1, seconds: number | null) => void
    /** Called when the result changes, and on a first result of 0. */
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
    private lastUp: 0 | 1 | null = null
    private readonly intervalMs: number
    private readonly timeoutMs: number

    constructor(private readonly options: DbProbeOptions) {
        this.intervalMs = options.intervalMs ?? DB_PROBE_INTERVAL_MS
        this.timeoutMs = options.timeoutMs ?? DB_PROBE_TIMEOUT_MS
    }

    public start(): void {
        if (this.timer) return
        void this.tick()
        this.timer = setInterval(() => void this.tick(), this.intervalMs)
        this.timer.unref?.()
    }

    public stop(): void {
        if (this.timer) clearInterval(this.timer)
        this.timer = null
    }

    /** One probe. Never rejects, and resolves within the timeout. */
    public async tick(): Promise<void> {
        if (this.inFlight) {
            this.record(0, null, `no answer to the probe started over ${this.timeoutMs} ms ago`)
            return
        }

        const started = performance.now()
        const query = Promise.resolve().then(() => this.options.probe())
        this.inFlight = query
        const settle = () => {
            if (this.inFlight === query) this.inFlight = null
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
                this.record(0, null, `no answer within ${this.timeoutMs} ms`)
            }
        } catch (error) {
            this.record(0, null, reasonOf(error))
        } finally {
            clearTimeout(timer)
        }
    }

    private record(up: 0 | 1, seconds: number | null, reason: string | null): void {
        this.options.report(up, seconds)
        const changed = this.lastUp === null ? up === 0 : this.lastUp !== up
        this.lastUp = up
        if (changed) this.options.onChange?.(up, reason)
    }
}
