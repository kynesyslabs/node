/**
 * Subsystem registry + boot tracker — Epic 13 T1/T2.
 *
 * Single source of truth for "what's up, what's down, how far did boot
 * get". Surfaced by `/health` (T7), Prometheus metrics (T6), and the TUI
 * (T9). The boot tracker is an ordered log of named steps; the subsystem
 * registry is the latest-known state per long-running subsystem.
 *
 * Design notes:
 * - State lives on the SharedState singleton (assigned at module load —
 *   see sharedState.ts). This file is the typed access layer.
 * - Helpers are pure functions, not class methods, so they import-cycle
 *   cleanly with sharedState.
 * - Logger emit is intentionally light (one line per state change). Heavy
 *   per-step instrumentation belongs in `index.ts` ANCHOR blocks (T3).
 */

import log from "@/utilities/logger"

// --- Subsystem registry ----------------------------------------------------

/**
 * Lifecycle states a subsystem can occupy. `dormant` is a special case
 * for subsystems intentionally skipped at boot when the node has no
 * peers (the `enough_peers=false` gate at src/index.ts:589-594).
 */
export type SubsystemStatus =
    | "pending"
    | "running"
    | "ready"
    | "failed"
    | "skipped"
    | "dormant"

export interface SubsystemInfo {
    /** Current state. */
    status: SubsystemStatus
    /** Unix ms when the subsystem entered its current status. */
    since: number | null
    /** Bound port, if any (after `getNextAvailablePort` drift resolution). */
    port?: number | null
    /** Originally requested port — non-null when drift occurred. */
    requestedPort?: number | null
    /** Last error recorded, if any. Cleared when status returns to ready. */
    lastError?: { at: number; message: string; source?: string } | null
    /** True only when the operator has explicitly turned the subsystem on. */
    enabled?: boolean
    /** Freeform side-channel data. Kept small — JSON-stringified into /health. */
    extra?: Record<string, unknown>
}

export interface MarkSubsystemOpts {
    port?: number | null
    requestedPort?: number | null
    enabled?: boolean
    extra?: Record<string, unknown>
    /** Skip-reason text. Only meaningful when status === "skipped". */
    reason?: string
}

/**
 * The 10 known subsystems the node manages. Adding a new one is fine —
 * the registry is open-keyed — but listing the canonical set here keeps
 * /health output stable for SDK consumers.
 */
export const KNOWN_SUBSYSTEMS = [
    "chain",
    "rpc",
    "metrics",
    "signaling",
    "mcp",
    "tlsnotary",
    "omni",
    "dtr",
    "l2ps",
    "main_loop",
] as const

export type KnownSubsystem = (typeof KNOWN_SUBSYSTEMS)[number]

/**
 * Build a fresh registry seeded with every known subsystem in "pending"
 * state. Called once at SharedState construction; further updates flow
 * through `markSubsystem`.
 */
export function buildInitialSubsystemRegistry(): Record<
    string,
    SubsystemInfo
> {
    const out: Record<string, SubsystemInfo> = {}
    for (const name of KNOWN_SUBSYSTEMS) {
        out[name] = { status: "pending", since: null }
    }
    return out
}

/**
 * Update a subsystem's status. Idempotent — re-marking with the same
 * status preserves `since`. Emits a one-line log on real transitions.
 *
 * Imported by both `index.ts` (boot anchors, T3) and individual
 * subsystem managers (T5 mainLoop heartbeat, etc.).
 */
export function markSubsystem(
    registry: Record<string, SubsystemInfo>,
    name: string,
    status: SubsystemStatus,
    opts: MarkSubsystemOpts = {},
): void {
    const prev = registry[name] ?? { status: "pending", since: null }
    const transitioned = prev.status !== status
    const next: SubsystemInfo = {
        status,
        since: transitioned ? Date.now() : prev.since,
        port: opts.port !== undefined ? opts.port : prev.port,
        requestedPort:
            opts.requestedPort !== undefined
                ? opts.requestedPort
                : prev.requestedPort,
        lastError: status === "ready" ? null : prev.lastError ?? null,
        enabled: opts.enabled !== undefined ? opts.enabled : prev.enabled,
        extra: opts.extra ?? prev.extra,
    }
    if (status === "skipped" && opts.reason) {
        next.extra = { ...(next.extra ?? {}), reason: opts.reason }
    }
    registry[name] = next
    if (transitioned) {
        log.info(`[BOOT] subsystem ${name}: ${prev.status} -> ${status}`)
    }
}

/** Record a failure with structured error info. Status becomes "failed". */
export function subsystemError(
    registry: Record<string, SubsystemInfo>,
    name: string,
    err: unknown,
    source?: string,
): void {
    const message = err instanceof Error ? err.message : String(err)
    const prev = registry[name] ?? { status: "pending", since: null }
    registry[name] = {
        ...prev,
        status: "failed",
        since: Date.now(),
        lastError: { at: Date.now(), message, source },
    }
    log.error(`[BOOT] subsystem ${name} failed: ${message}`)
}

/** Deep-clone the registry — used by `/health` JSON + TUI snapshots. */
export function snapshotSubsystems(
    registry: Record<string, SubsystemInfo>,
): Record<string, SubsystemInfo> {
    const out: Record<string, SubsystemInfo> = {}
    for (const [k, v] of Object.entries(registry)) {
        out[k] = {
            status: v.status,
            since: v.since,
            port: v.port ?? null,
            requestedPort: v.requestedPort ?? null,
            lastError: v.lastError
                ? { ...v.lastError }
                : null,
            enabled: v.enabled,
            extra: v.extra ? { ...v.extra } : undefined,
        }
    }
    return out
}

// --- Boot tracker ----------------------------------------------------------

export type BootStepStatus =
    | "pending"
    | "running"
    | "ready"
    | "failed"
    | "skipped"

export interface BootStep {
    /** Position in the registered-order sequence. */
    idx: number
    /** Caller-supplied step name (e.g. "chain.setup", "metrics_server"). */
    name: string
    status: BootStepStatus
    startedAt: number | null
    finishedAt: number | null
    error?: { message: string; at: number } | null
    skippedReason?: string | null
}

/**
 * Append-only ordered list of boot steps. Built by calls to
 * `bootRegister/start/ready/fail/skip` from `index.ts` ANCHOR blocks.
 * Surfaced via `/health.boot` + Prometheus `demos_boot_step_status`.
 */
export class BootTracker {
    private steps: BootStep[] = []
    private idxByName = new Map<string, number>()

    register(name: string): void {
        if (this.idxByName.has(name)) return
        const idx = this.steps.length
        this.steps.push({
            idx,
            name,
            status: "pending",
            startedAt: null,
            finishedAt: null,
        })
        this.idxByName.set(name, idx)
    }

    start(name: string): void {
        this.register(name)
        const step = this.steps[this.idxByName.get(name)!]
        step.status = "running"
        step.startedAt = Date.now()
        step.finishedAt = null
        step.error = null
        step.skippedReason = null
    }

    ready(name: string): void {
        this.register(name)
        const step = this.steps[this.idxByName.get(name)!]
        step.status = "ready"
        step.finishedAt = Date.now()
    }

    fail(name: string, err: unknown): void {
        this.register(name)
        const step = this.steps[this.idxByName.get(name)!]
        step.status = "failed"
        step.finishedAt = Date.now()
        step.error = {
            message: err instanceof Error ? err.message : String(err),
            at: Date.now(),
        }
    }

    skip(name: string, reason: string): void {
        this.register(name)
        const step = this.steps[this.idxByName.get(name)!]
        step.status = "skipped"
        step.finishedAt = Date.now()
        step.skippedReason = reason
    }

    /** Deep-clone snapshot for serialisation. */
    snapshot(): BootStep[] {
        return this.steps.map(s => ({
            idx: s.idx,
            name: s.name,
            status: s.status,
            startedAt: s.startedAt,
            finishedAt: s.finishedAt,
            error: s.error ? { ...s.error } : null,
            skippedReason: s.skippedReason ?? null,
        }))
    }

    /** Aggregate counts for `/health.boot.steps_*`. */
    summary(): {
        total: number
        ready: number
        failed: number
        skipped: number
        running: number
        pending: number
        complete: boolean
        current: string | null
    } {
        let ready = 0
        let failed = 0
        let skipped = 0
        let running = 0
        let pending = 0
        let current: string | null = null
        for (const s of this.steps) {
            switch (s.status) {
                case "ready":
                    ready++
                    break
                case "failed":
                    failed++
                    break
                case "skipped":
                    skipped++
                    break
                case "running":
                    running++
                    if (!current) current = s.name
                    break
                case "pending":
                    pending++
                    break
            }
        }
        const total = this.steps.length
        const complete =
            total > 0 && running === 0 && pending === 0 && failed === 0
        return {
            total,
            ready,
            failed,
            skipped,
            running,
            pending,
            complete,
            current,
        }
    }
}
