export type XmOpOutcome = "ok" | "failed" | "unknown"

// Tasks that send a signed transaction to another chain.
const WRITE_TASKS = new Set(["pay", "contract_write"])

/**
 * How one XM operation ended, read from its executor's reply. Only an
 * explicit success counts: a sent transaction names its hash, a read sets
 * its status. "unknown" is a submit that may have landed (it carries the
 * hash). Any other shape, including an empty reply, is a failure.
 */
export function xmOpOutcome(taskType: unknown, reply: unknown): XmOpOutcome {
    if (reply === null || typeof reply !== "object") return "failed"
    const r = reply as Record<string, unknown>
    if (r.result === "unknown") return "unknown"
    if (r.result === "error") return "failed"
    if (WRITE_TASKS.has(String(taskType))) {
        const sent =
            r.result === "success" && typeof r.hash === "string" && r.hash !== ""
        return sent ? "ok" : "failed"
    }
    return r.status === true || r.status === "success" ? "ok" : "failed"
}

export type XmScriptVerdict = "all_ops_ok" | "partial_success" | "all_ops_failed"

/** The script-level verdict: all_ops_ok only when every operation is "ok". */
export function xmScriptVerdict(outcomes: XmOpOutcome[]): XmScriptVerdict {
    if (outcomes.length > 0 && outcomes.every(o => o === "ok")) return "all_ops_ok"
    if (outcomes.every(o => o === "failed")) return "all_ops_failed"
    return "partial_success"
}
