import { EnvKey } from "../../config/envKeys"
import type { SetupContext } from "./context"
import { inspectSubnets, type SubnetStatus } from "./l2ps"
import { inspectBatchArtifacts, inspectIdentityKey } from "./zk"
import {
    parseBool,
    validateNonNegativeInt,
    validatePort,
} from "./validate"

export type CheckStatus = "ok" | "missing" | "invalid" | "warn" | "off"

export interface CheckItem {
    area: string
    item: string
    status: CheckStatus
    detail: string
    /** A missing/invalid blocking item stops a non-interactive start. */
    blocking: boolean
    fix?: string
}

export interface CheckReport {
    items: CheckItem[]
    subnets: SubnetStatus[]
    /** Subnets the node will actually load. */
    activeSubnets: string[]
}

export const SETUP_COMMAND = "bun run setup"

const L2PS_FIX = `${SETUP_COMMAND} --only l2ps`
const ZK_FIX = `${SETUP_COMMAND} --only zk`

export const isProblem = (i: CheckItem) =>
    i.blocking && (i.status === "missing" || i.status === "invalid")

export function collectChecks(ctx: SetupContext): CheckReport {
    const items: CheckItem[] = []
    const subnets = inspectSubnets(ctx.root).filter(s => s.state !== "placeholder")
    const activeSubnets = subnets.filter(s => s.state === "ok").map(s => s.uid)

    if (subnets.length === 0) {
        items.push({
            area: "L2PS",
            item: "Subnet",
            status: "off",
            detail: "none configured (L2PS is not used on this node)",
            blocking: false,
            fix: L2PS_FIX,
        })
    }
    for (const s of subnets) {
        const item = `Subnet ${s.uid}`
        if (s.state === "ok") {
            items.push({
                area: "L2PS",
                item,
                status: s.warnings.length > 0 ? "warn" : "ok",
                detail:
                    s.warnings.length > 0
                        ? s.warnings.join("; ")
                        : "config and key files are in place",
                blocking: false,
            })
        } else if (s.state === "disabled") {
            items.push({
                area: "L2PS",
                item,
                status: "off",
                detail: "disabled (\"enabled\": false)",
                blocking: false,
            })
        } else {
            items.push({
                area: "L2PS",
                item,
                status: s.state === "missing-files" ? "missing" : "invalid",
                detail: s.problems.join("; "),
                blocking: true,
                fix: L2PS_FIX,
            })
        }
    }

    items.push(...envChecks(ctx, activeSubnets.length > 0))
    items.push(...zkChecks(ctx, activeSubnets.length > 0))
    return { items, subnets, activeSubnets }
}

function envChecks(ctx: SetupContext, hasSubnet: boolean): CheckItem[] {
    const out: CheckItem[] = []
    const env = ctx.env

    const retention = env[EnvKey.L2PS_HISTORY_RETENTION_DAYS]
    if (retention !== undefined && retention !== "") {
        const r = validateNonNegativeInt(retention)
        out.push({
            area: "L2PS",
            item: "History retention",
            status: r.ok ? "ok" : "invalid",
            detail: r.ok
                ? r.value === 0
                    ? "keeps history forever"
                    : `${r.value} days`
                : `${EnvKey.L2PS_HISTORY_RETENTION_DAYS}=${retention}: ${r.error}`,
            blocking: false,
            fix: r.ok ? undefined : L2PS_FIX,
        })
    }
    if (parseBool(env[EnvKey.L2PS_HISTORY_STORE_PLAINTEXT]) === true) {
        out.push({
            area: "L2PS",
            item: "Plaintext history",
            status: "warn",
            detail: "message bodies are stored unencrypted in the database",
            blocking: false,
        })
    }

    const messaging = parseBool(env[EnvKey.L2PS_MESSAGING_ENABLED])
    if (messaging === true) {
        const rawPort = env[EnvKey.L2PS_MESSAGING_PORT]
        const port = rawPort === undefined ? undefined : validatePort(rawPort)
        out.push({
            area: "L2PS messaging",
            item: "Subnet for messaging",
            status: hasSubnet ? "ok" : "missing",
            detail: hasSubnet
                ? "at least one subnet is loaded"
                : "messaging is on but no usable subnet exists",
            blocking: !hasSubnet,
            fix: hasSubnet ? undefined : L2PS_FIX,
        })
        out.push({
            area: "L2PS messaging",
            item: "Port",
            status: port === undefined || port.ok ? "ok" : "invalid",
            detail:
                port === undefined
                    ? "default 3006"
                    : port.ok
                      ? String(port.value)
                      : `${EnvKey.L2PS_MESSAGING_PORT}=${rawPort}: ${port.error}; the node falls back to 3006`,
            blocking: false,
            fix: port === undefined || port.ok ? undefined : L2PS_FIX,
        })
    } else {
        out.push({
            area: "L2PS messaging",
            item: "Messaging",
            status: "off",
            detail: "not enabled",
            blocking: false,
        })
    }
    return out
}

function zkChecks(ctx: SetupContext, hasSubnet: boolean): CheckItem[] {
    const out: CheckItem[] = []

    const identity = inspectIdentityKey(ctx.root)
    out.push({
        area: "ZK identity",
        item: "Verification key",
        status: identity.state,
        detail: identity.detail,
        blocking: identity.state !== "ok",
        fix:
            identity.state === "ok"
                ? undefined
                : "restore the committed file: git checkout -- src/features/zk/keys/verification_key_merkle.json",
    })

    const flag = parseBool(ctx.env[EnvKey.L2PS_ZK_ENABLED])
    // The code default is on, which only means "use the keys if they exist";
    // an explicit true is the operator asking for proofs.
    const requested = flag === true && hasSubnet
    const batches = inspectBatchArtifacts(ctx.root)
    const anyComplete = batches.some(b => b.complete)

    if (!requested) {
        out.push({
            area: "L2PS ZK",
            item: "Batch proofs",
            status: anyComplete ? "ok" : "off",
            detail:
                flag === true
                    ? "L2PS_ZK_ENABLED=true but no subnet is configured, nothing to prove"
                    : flag === false
                      ? "off (L2PS_ZK_ENABLED=false)"
                      : anyComplete
                        ? "keys are present; proofs are used when a subnet is joined"
                        : "not requested (set L2PS_ZK_ENABLED=true to require them)",
            blocking: false,
            fix: anyComplete ? undefined : ZK_FIX,
        })
        return out
    }

    for (const b of batches) {
        const missing = [
            !b.zkey && "proving key",
            !b.wasm && "circuit wasm",
            !b.vkey && "verification key",
        ].filter(Boolean)
        const blocking = !anyComplete
        out.push({
            area: "L2PS ZK",
            item: `Batch of up to ${b.size}`,
            status: b.complete ? "ok" : blocking ? "missing" : "warn",
            detail: b.complete
                ? "proving key, circuit and verification key are in place"
                : anyComplete
                  ? `${missing.join(", ")} missing; batches above ${Math.max(...batches.filter(x => x.complete).map(x => x.size))} transactions cannot be proven`
                  : `${missing.join(", ")} missing`,
            blocking,
            fix: b.complete ? undefined : ZK_FIX,
        })
    }
    return out
}

const LABELS: Record<CheckStatus, string> = {
    ok: "configured",
    missing: "MISSING",
    invalid: "INVALID",
    warn: "warning",
    off: "off",
}

export function renderTable(items: CheckItem[]): string {
    const rows = items.map(i => [i.area, i.item, LABELS[i.status], i.detail])
    const head = ["Area", "Item", "Status", "Details"]
    const widths = head.map((h, c) =>
        Math.max(h.length, ...rows.map(r => (c < 3 ? r[c].length : 0))),
    )
    const fmt = (r: string[]) =>
        r
            .map((cell, c) => (c < 3 ? cell.padEnd(widths[c]) : cell))
            .join("  ")
            .trimEnd()
    return [
        fmt(head),
        widths
            .slice(0, 3)
            .map(w => "-".repeat(w))
            .join("  ") + "  -------",
        ...rows.map(fmt),
    ].join("\n")
}

export function summarize(items: CheckItem[]): string {
    const count = (s: CheckStatus) => items.filter(i => i.status === s).length
    return `${count("ok")} configured, ${count("missing")} missing, ${count("invalid")} invalid, ${count("warn")} warnings, ${count("off")} off`
}

export function fixesFor(items: CheckItem[]): string[] {
    return [
        ...new Set(
            items
                .filter(i => (i.status === "missing" || i.status === "invalid") && i.fix)
                .map(i => i.fix as string),
        ),
    ]
}
