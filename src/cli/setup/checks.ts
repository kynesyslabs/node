import { EnvKey } from "../../config/envKeys"
import {
    parseBoolFlag,
    parseIntSetting,
    parseMessagingEnabled,
    parseMessagingPort,
} from "../../config/envFlags"
import type { SetupContext } from "./context"
import { inspectSubnets, type SubnetStatus } from "./l2ps"
import { inspectBatchArtifacts, inspectIdentityKey, type BatchArtifacts } from "./zk"
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

function portItem(rawPort: string | undefined): CheckItem {
    const node = parseMessagingPort(rawPort)
    // The setup writes plain digits; a value the node reads differently (or
    // compose rejects) is worth saying so.
    const strict = rawPort === undefined ? undefined : validatePort(rawPort)
    const exact = strict?.ok === true && strict.value === node.port
    const base = { area: "L2PS messaging", item: "Port", blocking: false }
    const key = EnvKey.L2PS_MESSAGING_PORT
    if (node.source === "default") {
        return { ...base, status: "ok", detail: `default ${node.port}` }
    }
    if (exact) return { ...base, status: "ok", detail: String(node.port) }
    if (node.source === "env") {
        return {
            ...base,
            status: "warn",
            detail: `${key}=${rawPort}: the node reads it as ${node.port}, but docker compose rejects it; write plain digits`,
            fix: L2PS_FIX,
        }
    }
    return {
        ...base,
        status: "invalid",
        detail: `${key}=${rawPort}: not a port from 1 to 65535; the node falls back to ${node.port}`,
        fix: L2PS_FIX,
    }
}

function messagingItems(env: SetupContext["env"], hasSubnet: boolean): CheckItem[] {
    if (!parseMessagingEnabled(env[EnvKey.L2PS_MESSAGING_ENABLED])) {
        return [{ area: "L2PS messaging", item: "Messaging", status: "off", detail: "not enabled", blocking: false }]
    }
    const subnet: CheckItem = {
        area: "L2PS messaging",
        item: "Subnet for messaging",
        status: hasSubnet ? "ok" : "missing",
        detail: hasSubnet ? "at least one subnet is loaded" : "messaging is on but no usable subnet exists",
        blocking: !hasSubnet,
        fix: hasSubnet ? undefined : L2PS_FIX,
    }
    return [subnet, portItem(env[EnvKey.L2PS_MESSAGING_PORT])]
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
    out.push(...messagingItems(env, hasSubnet))
    return out
}

function identityItem(root: string): CheckItem {
    const identity = inspectIdentityKey(root)
    return {
        area: "ZK identity",
        item: "Verification key",
        status: identity.state,
        detail: identity.detail,
        blocking: identity.state !== "ok",
        fatal: true,
        fix: identity.state === "ok" ? undefined : IDENTITY_KEY_FIX,
    }
}

/** Why batch proofs are not being required, in the operator's terms. */
function notRequestedDetail(flag: boolean | undefined, anyComplete: boolean): string {
    if (flag === true) return "L2PS_ZK_ENABLED=true but no subnet is configured, nothing to prove"
    if (flag === false) return "off (L2PS_ZK_ENABLED=false)"
    if (anyComplete) return "keys are present; proofs are used when a subnet is joined"
    return "not requested (set L2PS_ZK_ENABLED=true to require them)"
}

function batchItem(b: BatchArtifacts, batches: BatchArtifacts[], anyComplete: boolean): CheckItem {
    const base = { area: "L2PS ZK", item: `Batch of up to ${b.size}` }
    if (b.complete) {
        return { ...base, status: "ok", detail: "proving key, circuit and verification key are in place", blocking: false }
    }
    const missing = [!b.zkey && "proving key", !b.wasm && "circuit wasm", !b.vkey && "verification key"]
        .filter(Boolean)
        .join(", ")
    if (!anyComplete) {
        return { ...base, status: "missing", detail: `${missing} missing`, blocking: true, fix: ZK_FIX }
    }
    const largest = Math.max(...batches.filter(x => x.complete).map(x => x.size))
    return {
        ...base,
        status: "warn",
        detail: `${missing} missing; batches above ${largest} transactions cannot be proven`,
        blocking: false,
        fix: ZK_FIX,
    }
}

function zkChecks(ctx: SetupContext, hasSubnet: boolean): CheckItem[] {
    const out: CheckItem[] = [identityItem(ctx.root)]
    const flag = parseBoolFlag(ctx.env[EnvKey.L2PS_ZK_ENABLED])
    const batches = inspectBatchArtifacts(ctx.root)
    const anyComplete = batches.some(b => b.complete)

    // The code default is on, which only means "use the keys if they exist";
    // an explicit true is the operator asking for proofs.
    if (!(flag === true && hasSubnet)) {
        out.push({
            area: "L2PS ZK",
            item: "Batch proofs",
            status: anyComplete ? "ok" : "off",
            detail: notRequestedDetail(flag, anyComplete),
            blocking: false,
            fix: anyComplete ? undefined : ZK_FIX,
        })
        return out
    }
    out.push(...batches.map(b => batchItem(b, batches, anyComplete)))
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
