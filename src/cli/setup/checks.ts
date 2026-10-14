import { EnvKey } from "../../config/envKeys"
import {
    parseBoolFlag,
    parseIntSetting,
    parseMessagingEnabled,
    parseMessagingPort,
} from "../../config/envFlags"
import type { SetupContext } from "./context"
import { inspectSubnets, type SubnetStatus } from "./l2ps"
import { inspectBatchArtifacts, inspectIdentityKey } from "./zk"
import { validatePort } from "./validate"

export type CheckStatus = "ok" | "missing" | "invalid" | "warn" | "off"

export interface CheckItem {
    area: string
    item: string
    status: CheckStatus
    detail: string
    /** A missing/invalid blocking item is reported loudly at start. */
    blocking: boolean
    /** Consensus-critical: a missing/invalid fatal item stops the node. */
    fatal?: boolean
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

export const isFatal = (i: CheckItem) => i.fatal === true && isProblem(i)

export const IDENTITY_KEY_FIX =
    "restore the committed src/features/zk/keys/verification_key_merkle.json from the repository (in Docker: rebuild or re-pull the image)"

/** Inspection must never take the caller down; a failure becomes a problem. */
function guarded(area: string, fn: () => CheckItem[]): CheckItem[] {
    try {
        return fn()
    } catch (e) {
        return [
            {
                area,
                item: "Inspection",
                status: "invalid",
                detail: `could not be checked (${e instanceof Error ? e.message : String(e)})`,
                blocking: true,
                fix: SETUP_COMMAND + " --check",
            },
        ]
    }
}

export function collectChecks(ctx: SetupContext): CheckReport {
    const items: CheckItem[] = []
    let subnets: SubnetStatus[] = []
    items.push(
        ...guarded("L2PS", () => {
            subnets = inspectSubnets(ctx.root).filter(s => s.state !== "placeholder")
            return subnetItems(subnets)
        }),
    )
    const activeSubnets = subnets.filter(s => s.state === "ok").map(s => s.uid)
    items.push(...guarded("L2PS", () => envChecks(ctx, activeSubnets.length > 0)))
    items.push(...guarded("ZK", () => zkChecks(ctx, activeSubnets.length > 0)))
    return { items, subnets, activeSubnets }
}

function subnetItems(subnets: SubnetStatus[]): CheckItem[] {
    const items: CheckItem[] = []

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

    return items
}

/**
 * An existing retention value, judged the way the node reads it (parseInt).
 * It is only called out when the node's reading differs from plain digits.
 */
function retentionItem(raw: string): CheckItem {
    const node = parseIntSetting(raw)
    const plainDigits = /^\d+$/.test(raw) && Number(raw) === node
    const base = { area: "L2PS", item: "History retention", blocking: false }
    if (node === undefined) {
        return {
            ...base,
            status: "invalid",
            detail: `${EnvKey.L2PS_HISTORY_RETENTION_DAYS}=${raw}: not a number; the node ignores it and keeps history forever`,
            fix: L2PS_FIX,
        }
    }
    if (node < 0) {
        return {
            ...base,
            status: "invalid",
            detail: `${EnvKey.L2PS_HISTORY_RETENTION_DAYS}=${raw}: negative; the node would read ${node}`,
            fix: L2PS_FIX,
        }
    }
    if (plainDigits) {
        return { ...base, status: "ok", detail: node === 0 ? "keeps history forever" : `${node} days` }
    }
    return {
        ...base,
        status: "warn",
        detail: `${EnvKey.L2PS_HISTORY_RETENTION_DAYS}=${raw}: the node will read this as ${node}; write plain digits`,
        fix: L2PS_FIX,
    }
}

function envChecks(ctx: SetupContext, hasSubnet: boolean): CheckItem[] {
    const out: CheckItem[] = []
    const env = ctx.env

    const retention = env[EnvKey.L2PS_HISTORY_RETENTION_DAYS]
    if (retention !== undefined && retention !== "") {
        out.push(retentionItem(retention))
    }
    if (parseBoolFlag(env[EnvKey.L2PS_HISTORY_STORE_PLAINTEXT]) === true) {
        out.push({
            area: "L2PS",
            item: "Plaintext history",
            status: "warn",
            detail: "message bodies are stored unencrypted in the database",
            blocking: false,
        })
    }

    if (parseMessagingEnabled(env[EnvKey.L2PS_MESSAGING_ENABLED])) {
        const rawPort = env[EnvKey.L2PS_MESSAGING_PORT]
        const node = parseMessagingPort(rawPort)
        // The setup writes plain digits; a value the node reads differently
        // (or compose rejects) is worth saying so.
        const strict = rawPort === undefined ? undefined : validatePort(rawPort)
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
        const exact = strict?.ok === true && strict.value === node.port
        out.push({
            area: "L2PS messaging",
            item: "Port",
            status:
                node.source === "default" || exact
                    ? "ok"
                    : node.source === "env"
                      ? "warn"
                      : "invalid",
            detail:
                node.source === "default"
                    ? `default ${node.port}`
                    : exact
                      ? String(node.port)
                      : node.source === "env"
                        ? `${EnvKey.L2PS_MESSAGING_PORT}=${rawPort}: the node reads it as ${node.port}, but docker compose rejects it; write plain digits`
                        : `${EnvKey.L2PS_MESSAGING_PORT}=${rawPort}: not a port from 1 to 65535; the node falls back to ${node.port}`,
            blocking: false,
            fix: node.source === "default" || exact ? undefined : L2PS_FIX,
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
        fatal: true,
        fix: identity.state === "ok" ? undefined : IDENTITY_KEY_FIX,
    })

    const flag = parseBoolFlag(ctx.env[EnvKey.L2PS_ZK_ENABLED])
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
