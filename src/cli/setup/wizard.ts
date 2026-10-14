import * as fs from "node:fs"
import * as path from "node:path"
import { EnvKey } from "../../config/envKeys"
import {
    parseBoolFlag,
    parseIntSetting,
    parseMessagingEnabled,
    parseMessagingPort,
} from "../../config/envFlags"
import type { SetupOptions } from "./args"
import {
    collectChecks,
    fixesFor,
    IDENTITY_KEY_FIX,
    renderTable,
    summarize,
} from "./checks"
import type { SetupContext } from "./context"
import {
    applyEnvChanges,
    diffEnv,
    readEnvFile,
    type EnvChange,
} from "./envFile"
import { isInsideDir, readTextIfExists, resolveSymlink, writeFileGuarded, type WriteOutcome } from "./files"
import {
    buildSubnetFiles,
    generateKeyMaterial,
    inspectSubnet,
    inspectSubnets,
    sameJson,
} from "./l2ps"
import { ask, confirm, select, type Prompter } from "./prompt"
import {
    normalizeHex,
    parseHex,
    validateIvHex,
    validateKeyHex,
    validateNonNegativeInt,
    validatePort,
    validateRpcList,
    validateUid,
    type Result,
} from "./validate"
import {
    inspectBatchArtifacts,
    inspectIdentityKey,
    missingZkTools,
    runL2psZkSetup,
    type ZkRunner,
} from "./zk"
import { L2PS_ZK_DIR } from "./context"

/** A required answer was not given and there is nobody to ask. */
export class SetupError extends Error {}

export interface WizardDeps {
    ctx: SetupContext
    opts: SetupOptions
    /** Absent means non-interactive: answers come from flags and DEMOS_SETUP_* only. */
    prompter?: Prompter
    say: (line: string) => void
    runner: ZkRunner
    randomBytes?: (n: number) => Buffer
    now?: () => number
}

export interface FileResult {
    rel: string
    outcome: WriteOutcome["status"] | "would-create" | "would-replace" | "would-keep"
    backup?: string
}

export interface WizardResult {
    exitCode: number
    files: FileResult[]
    envApplied: EnvChange[]
    /** Env lines that could not be written and must be added by hand. */
    manualEnv: Record<string, string>
    problems: string[]
    restartNeeded: boolean
}

export async function runWizard(deps: WizardDeps): Promise<WizardResult> {
    const { opts, say } = deps
    const result: WizardResult = {
        exitCode: 0,
        files: [],
        envApplied: [],
        manualEnv: {},
        problems: [],
        restartNeeded: false,
    }
    const wantedEnv: Record<string, string> = {}
    const state = { activeSubnets: new Set<string>() }

    say(
        opts.dryRun
            ? "Dry run: nothing will be written or downloaded."
            : "Demos node setup",
    )

    for (const s of inspectSubnets(deps.ctx.root)) {
        if (s.state === "ok") state.activeSubnets.add(s.uid)
    }

    if (opts.only !== "zk") {
        await l2psSection(deps, result, wantedEnv, state)
        // Messaging with no subnet to serve would put a warning banner at every
        // start (and stop a strict one), so the setup never produces that state.
        if (wantedEnv[EnvKey.L2PS_MESSAGING_ENABLED] === "true" && state.activeSubnets.size === 0) {
            delete wantedEnv[EnvKey.L2PS_MESSAGING_ENABLED]
            const msg = "Messaging was not enabled: it needs a usable L2PS subnet. Add one with --l2ps-uid <id>, then enable messaging."
            say(`  ${msg}`)
            result.problems.push(msg)
        }
    }
    if (opts.only !== "l2ps") {
        await zkSection(deps, result, wantedEnv, state)
    }
    await applyEnv(deps, result, wantedEnv)

    say("")
    if (opts.dryRun) {
        say("Dry run finished. Run again without --dry-run to apply.")
    } else {
        // The real environment normally wins over the env file, but `bun run`
        // loads the old .env into it first; what was just written must show.
        const written = Object.fromEntries(result.envApplied.map(c => [c.key, c.to]))
        const report = collectChecks({
            ...deps.ctx,
            env: { ...readEnvFile(deps.ctx.envFilePath), ...deps.ctx.processEnv, ...written },
        })
        say("Result")
        say(renderTable(report.items))
        say(summarize(report.items))
        const fixes = fixesFor(report.items)
        if (fixes.length > 0) say(`Still to do: ${fixes.join("  |  ")}`)
        if (result.restartNeeded) {
            say("Restart the node for the changes to take effect.")
        }
    }
    if (result.problems.length > 0) result.exitCode = 1
    return result
}

// ---------------------------------------------------------------------------
// L2PS
// ---------------------------------------------------------------------------

function ownRpcUrl(env: SetupContext["env"]): string {
    return (
        env[EnvKey.EXPOSED_URL] ||
        `http://127.0.0.1:${env[EnvKey.RPC_PORT] || 53550}`
    )
}

function readExistingConfig(root: string, uid: string): any {
    const text = readTextIfExists(path.join(root, "data", "l2ps", uid, "config.json"))
    try {
        return text === undefined ? undefined : JSON.parse(text)
    } catch {
        return undefined
    }
}

function orThrow<T>(r: Result<T>, label: string): T {
    if (!r.ok) throw new SetupError(`${label}: ${r.error}`)
    return r.value
}

// A key is a few dozen hex characters. Reading a bounded prefix keeps a path
// like /dev/zero or a huge file from hanging or exhausting memory, and still
// lets /dev/stdin and a named pipe work.
const SECRET_FILE_MAX_BYTES = 64 * 1024

function readSecretFile(file: string, label: string): string {
    let fd: number | undefined
    try {
        fd = fs.openSync(file, "r")
        const buf = Buffer.alloc(SECRET_FILE_MAX_BYTES + 1)
        let filled = 0
        while (filled < buf.length) {
            const n = fs.readSync(fd, buf, filled, buf.length - filled, null)
            if (n === 0) break
            filled += n
        }
        if (filled > SECRET_FILE_MAX_BYTES) {
            throw new Error(`more than ${SECRET_FILE_MAX_BYTES} bytes, which no key is`)
        }
        return buf.subarray(0, filled).toString("utf8")
    } catch (e) {
        throw new SetupError(`Cannot read ${label} file ${file}: ${e instanceof Error ? e.message : e}`)
    } finally {
        if (fd !== undefined) fs.closeSync(fd)
    }
}

async function l2psSection(
    deps: WizardDeps,
    result: WizardResult,
    wantedEnv: Record<string, string>,
    state: { activeSubnets: Set<string> },
): Promise<void> {
    const { ctx, opts, prompter, say } = deps
    say("")
    say("L2PS (private subnets)")

    const subnets = inspectSubnets(ctx.root).filter(s => s.state !== "placeholder")
    for (const s of subnets) {
        say(
            `  Found subnet ${s.uid}: ${s.state === "ok" ? "ready" : s.state === "disabled" ? "disabled" : "needs repair"}`,
        )
        for (const p of s.problems) say(`    - ${p}`)
    }
    const broken = subnets.filter(s => s.state === "invalid" || s.state === "missing-files")

    // History and messaging flags are node-wide: they apply to a healthy
    // existing subnet too, so they must not depend on adding or repairing one.
    const envFlagGiven =
        opts.retentionDays !== undefined ||
        opts.storePlaintext !== undefined ||
        opts.requireV2 !== undefined ||
        opts.messaging !== undefined ||
        opts.messagingPort !== undefined
    const applyFlagsOnly = () =>
        envFlagGiven ? collectL2psEnv({ ...deps, prompter: undefined }, wantedEnv) : Promise.resolve()

    let enable = opts.l2ps ?? (opts.uid !== undefined ? true : undefined)
    if (enable === undefined) {
        if (!prompter) {
            await applyFlagsOnly()
            say(
                envFlagGiven
                    ? "  No subnet requested (use --l2ps-uid <id> to set one up); only the options you gave are applied."
                    : "  Nothing requested (use --l2ps-uid <id> to set up a subnet). Left as it is.",
            )
            return
        }
        const question =
            state.activeSubnets.size > 0
                ? "Add or change an L2PS subnet?"
                : broken.length > 0
                  ? "Repair the broken subnet now?"
                  : "Enable L2PS on this node?"
        enable = await confirm(prompter, question, broken.length > 0, say)
    }
    if (!enable) {
        await applyFlagsOnly()
        say("  L2PS subnets left as they are.")
        return
    }

    const uid =
        opts.uid ??
        (prompter
            ? await ask(prompter, "Subnet id (letters, digits, _ and -)", {
                  default: broken.length === 1 ? broken[0].uid : undefined,
                  validate: v => {
                      const r = validateUid(v)
                      return r.ok ? null : r.error
                  },
                  say,
              })
            : missing("--l2ps-uid", "DEMOS_SETUP_L2PS_UID"))

    const existing = inspectSubnet(ctx.root, uid)
    const hasKeyInput =
        opts.keyFile !== undefined || opts.keyHex !== undefined ||
        opts.ivFile !== undefined || opts.ivHex !== undefined

    let role = opts.role ?? (hasKeyInput ? "join" : undefined)
    if (role === undefined) {
        role =
            existing.state === "ok" || !prompter
                ? "create"
                : await select(
                      prompter,
                      "Is this a new subnet or one you are joining?",
                      [
                          { value: "create", label: "Create a new subnet (a fresh key is generated)" },
                          { value: "join", label: "Join an existing subnet (import its key and IV)" },
                      ],
                      "create",
                      say,
                  )
    }

    let importedKey: string | undefined
    let importedIv: string | undefined
    if (role === "join") {
        importedKey = await secretInput(deps, "key", opts.keyHex, opts.keyFile, validateKeyHex,
            "Subnet key (hex, input is hidden)", "--l2ps-key-file", "DEMOS_SETUP_L2PS_KEY")
        importedIv = await secretInput(deps, "IV", opts.ivHex, opts.ivFile, validateIvHex,
            "Subnet IV (hex, input is hidden)", "--l2ps-iv-file", "DEMOS_SETUP_L2PS_IV")
    }

    const existingConfig = readExistingConfig(ctx.root, uid)
    const knownRpcs: string[] | undefined =
        Array.isArray(existingConfig?.config?.known_rpcs) &&
        existingConfig.config.known_rpcs.length > 0
            ? existingConfig.config.known_rpcs
            : undefined
    let rpcs = opts.rpcs
    if (rpcs === undefined) {
        const fallback = knownRpcs ?? [ownRpcUrl(ctx.env)]
        rpcs = prompter
            ? orThrow(
                  validateRpcList(
                      await ask(prompter, "RPC URLs of the subnet members, comma separated", {
                          default: fallback.join(","),
                          validate: v => {
                              const r = validateRpcList(v)
                              return r.ok ? null : r.error
                          },
                          say,
                      }),
                  ),
                  "RPC list",
              )
            : knownRpcs ?? orThrow(
                  validateRpcList(fallback),
                  "EXPOSED_URL or RPC_PORT does not give a usable RPC URL for this subnet (pass --l2ps-rpc)",
              )
    }

    await collectL2psEnv(deps, wantedEnv)

    // Honour key locations an existing config.json already names, as long as
    // they stay inside the node directory (the loader refuses anything else).
    const configured = (rel: unknown): string | undefined => {
        if (typeof rel !== "string" || rel === "") return undefined
        const abs = path.resolve(ctx.root, rel)
        return abs.startsWith(path.resolve(ctx.root) + path.sep) ? rel : undefined
    }
    const keyRel = configured(existingConfig?.keys?.private_key_path) ?? `data/l2ps/${uid}/private_key.txt`
    const ivRel = configured(existingConfig?.keys?.iv_path) ?? `data/l2ps/${uid}/iv.txt`

    // Reuse what is already on disk before generating anything new.
    const reuse = (rel: string): string | undefined => {
        const text = readTextIfExists(path.resolve(ctx.root, rel))
        const parsed = text === undefined ? undefined : parseHex(text, "value")
        return parsed?.ok ? parsed.value : undefined
    }
    const generated = opts.dryRun
        ? { keyHex: "<new random key>", ivHex: "<new random iv>" }
        : generateKeyMaterial(deps.randomBytes)
    const haveKey = importedKey ?? reuse(keyRel)
    const haveIv = importedIv ?? reuse(ivRel)
    // Key and IV belong together. One of them being new next to an old other
    // half is a subnet this node can no longer share with its members.
    for (const [have, other, label, rel] of [
        [haveIv, haveKey, "IV", ivRel],
        [haveKey, haveIv, "key", keyRel],
    ] as const) {
        if (have === undefined && other !== undefined) {
            say(`  Warning: ${rel} was missing or unusable, so a new random ${label} is generated. If other nodes share this subnet, get the original ${label} from its owner and import it; this node cannot read their traffic with a different one.`)
        }
    }
    const files = buildSubnetFiles({
        uid,
        rpcs,
        keyHex: haveKey ?? generated.keyHex,
        ivHex: haveIv ?? generated.ivHex,
        existingConfig,
        keyRel,
        ivRel,
    })

    // Decide every file before writing any, so a refused key leaves the
    // subnet exactly as it was.
    interface Decision {
        file: (typeof files)[number]
        abs: string
        current?: string
        differs: boolean
        overwrite: boolean
        sameData: boolean
    }
    const decisions: Decision[] = []
    const blocked: string[] = []
    for (const f of files) {
        const abs = path.resolve(ctx.root, f.rel)
        const current = readTextIfExists(abs)
        // Key material is compared as normalised hex, so a missing trailing
        // newline is not a difference; config as data, so layout is not either.
        const sameData =
            current !== undefined &&
            (f.secret
                ? normalizeHex(current) === normalizeHex(f.content)
                : f.rel.endsWith(".json")
                  ? sameJson(current, f.content)
                  : current === f.content)
        const differs = current !== undefined && !sameData
        let overwrite = false
        if (differs) {
            if (opts.force) overwrite = true
            else if (prompter && !opts.dryRun) {
                overwrite = await confirm(
                    prompter,
                    `${f.rel} already exists with different content. Replace it? (the old file is kept as .bak)`,
                    false,
                    say,
                )
            }
        }
        if (differs && !overwrite && f.secret) {
            blocked.push(`${f.rel === keyRel ? "key" : "IV"} differs`)
        }
        decisions.push({ file: f, abs, current, differs, overwrite, sameData })
    }
    if (blocked.length > 0) {
        const msg = `Subnet ${uid}: ${blocked.join(", ")}; re-run with --force to replace it (the old file is kept as .bak). Nothing was changed.`
        say(`  ${msg}`)
        result.problems.push(msg)
        return
    }

    // Secrets first, config last: a half-finished run then leaves key files
    // nobody points at instead of a config that names keys which do not exist.
    const ordered = [...decisions].sort((a, b) => Number(!a.file.secret) - Number(!b.file.secret))
    let current = ""
    try {
        for (const d of ordered) {
            const f = d.file
            current = f.rel
            if (opts.dryRun) {
                const outcome =
                    d.current === undefined ? "would-create" : d.differs && d.overwrite ? "would-replace" : "would-keep"
                result.files.push({ rel: f.rel, outcome })
                say(`  ${outcome.replace("-", " ")}: ${f.rel}${f.secret ? " (mode 600, contents never shown)" : ""}`)
                continue
            }
            if (d.sameData) {
                // Same data, possibly a different layout: keep the operator's text
                // and only tighten the file mode if it was too open.
                const outcome = writeFileGuarded(d.abs, d.current as string, { mode: f.mode, overwrite: false })
                result.files.push({ rel: f.rel, outcome: outcome.status })
                say(`  unchanged ${f.rel}`)
                continue
            }
            const outcome = writeFileGuarded(d.abs, f.content, { mode: f.mode, overwrite: d.overwrite }, deps.now)
            result.files.push({
                rel: f.rel,
                outcome: outcome.status,
                backup: outcome.status === "replaced" ? outcome.backup : undefined,
            })
            say(describe(f.rel, outcome, f.secret, d.differs && !d.overwrite))
        }
    } catch (e) {
        const msg = `Subnet ${uid}: could not write ${current} (${e instanceof Error ? e.message : String(e)}). Fix that and run the setup again.`
        say(`  ${msg}`)
        result.problems.push(msg)
        return
    }

    if (opts.dryRun) {
        state.activeSubnets.add(uid)
        return
    }
    const after = inspectSubnet(ctx.root, uid)
    if (after.state === "ok") {
        state.activeSubnets.add(uid)
        say(`  Subnet ${uid} is ready.`)
        for (const w of after.warnings) say(`  Warning: ${w}`)
    } else {
        result.problems.push(`Subnet ${uid} is still not usable: ${after.problems.join("; ")}`)
        say(`  Subnet ${uid} is still not usable:`)
        for (const p of after.problems) say(`    - ${p}`)
    }
}

function describe(rel: string, o: WriteOutcome, secret: boolean, keptDiffering: boolean): string {
    switch (o.status) {
        case "created":
            return `  created ${rel}${secret ? " (mode 600, contents never shown)" : ""}`
        case "unchanged":
            return `  unchanged ${rel}`
        case "replaced":
            return `  replaced ${rel} (old version saved as ${path.basename(o.backup)})`
        case "kept":
            return `  kept ${rel}${keptDiffering ? " (differs from the answers; pass --force to replace it)" : ""}`
    }
}

function missing(flag: string, env: string): never {
    throw new SetupError(
        `Missing answer: ${flag} (or ${env}). Run without --yes to be asked.`,
    )
}

async function secretInput(
    deps: WizardDeps,
    label: string,
    hex: string | undefined,
    file: string | undefined,
    validator: (v: string) => Result<string>,
    question: string,
    flag: string,
    envName: string,
): Promise<string> {
    const raw = hex ?? (file !== undefined ? readSecretFile(path.resolve(deps.ctx.root, file), label) : undefined)
    if (raw !== undefined) return orThrow(validator(raw), `Subnet ${label}`)
    if (!deps.prompter) {
        return missing(flag, envName)
    }
    const v = await ask(deps.prompter, question, {
        secret: true,
        validate: x => {
            const r = validator(x)
            return r.ok ? null : r.error
        },
        say: deps.say,
    })
    return orThrow(validator(v), `Subnet ${label}`)
}

/**
 * An explicit flag is always written. A prompted answer is written only when
 * its meaning differs from what is in effect now, so the env file does not fill
 * up with the built-in defaults the operator accepted. The comparison is on the
 * parsed meaning, not on the text: `TRUE` means on for messaging and off for the
 * other flags, and answering "no" must be written whenever the node reads the
 * current value as on.
 */
function putSetting(
    wanted: Record<string, string>,
    key: string,
    value: boolean | number,
    current: boolean | number,
    prompted: boolean,
): void {
    if (!prompted || value !== current) wanted[key] = String(value)
}

interface FlagQuestion {
    key: string
    given: boolean | undefined
    /** What the node reads the current environment as, by the node's own rule. */
    current: boolean
    question: string
    /** A second question asked after a yes; a no there turns the answer back to no. */
    confirmYes?: string
}

/** Asks about one on/off setting when it was not given, records the answer, and returns it. */
async function collectFlag(deps: WizardDeps, wanted: Record<string, string>, q: FlagQuestion): Promise<boolean | undefined> {
    const { prompter, say } = deps
    let value = q.given
    const prompted = value === undefined && prompter !== undefined
    if (prompted) {
        value = await confirm(prompter, q.question, q.current, say)
        if (value && q.confirmYes !== undefined && !(await confirm(prompter, q.confirmYes, false, say))) {
            value = false
        }
    }
    if (value !== undefined) putSetting(wanted, q.key, value, q.current, prompted)
    return value
}

async function collectRetention(deps: WizardDeps, wanted: Record<string, string>): Promise<void> {
    const { opts, prompter, ctx, say } = deps
    const current = parseIntSetting(ctx.env[EnvKey.L2PS_HISTORY_RETENTION_DAYS]) ?? 0
    let days = opts.retentionDays
    const prompted = days === undefined && prompter !== undefined
    if (prompted) {
        const answer = await ask(prompter, "Days to keep subnet history (0 keeps it forever)", {
            default: String(current),
            validate: x => {
                const r = validateNonNegativeInt(x)
                return r.ok ? null : r.error
            },
            say,
        })
        const parsed = validateNonNegativeInt(answer)
        days = parsed.ok ? parsed.value : undefined
    }
    if (days !== undefined) putSetting(wanted, EnvKey.L2PS_HISTORY_RETENTION_DAYS, days, current, prompted)
}

async function collectPort(deps: WizardDeps, wanted: Record<string, string>): Promise<void> {
    const { opts, prompter, ctx, say } = deps
    const current = parseMessagingPort(ctx.env[EnvKey.L2PS_MESSAGING_PORT]).port
    let port = opts.messagingPort
    const prompted = port === undefined && prompter !== undefined
    if (prompted) {
        const answer = await ask(prompter, "Messaging port", {
            default: String(current),
            validate: x => {
                const r = validatePort(x)
                return r.ok ? null : r.error
            },
            say,
        })
        const parsed = validatePort(answer)
        port = parsed.ok ? parsed.value : undefined
    }
    if (port !== undefined) putSetting(wanted, EnvKey.L2PS_MESSAGING_PORT, port, current, prompted)
}

async function collectL2psEnv(deps: WizardDeps, wanted: Record<string, string>): Promise<void> {
    const { opts, ctx } = deps
    const env = ctx.env
    await collectRetention(deps, wanted)
    await collectFlag(deps, wanted, {
        key: EnvKey.L2PS_HISTORY_STORE_PLAINTEXT,
        given: opts.storePlaintext,
        current: parseBoolFlag(env[EnvKey.L2PS_HISTORY_STORE_PLAINTEXT]) ?? false,
        question: "Also store decrypted message bodies in the database? (not recommended)",
        confirmYes: "Message bodies will be readable by anyone with database access. Keep this on?",
    })
    await collectFlag(deps, wanted, {
        key: EnvKey.L2PS_HISTORY_REQUIRE_V2,
        given: opts.requireV2,
        current: parseBoolFlag(env[EnvKey.L2PS_HISTORY_REQUIRE_V2]) ?? false,
        question: "Refuse the old history signature? (turn on only once clients sign the new form)",
    })
    const messaging = await collectFlag(deps, wanted, {
        key: EnvKey.L2PS_MESSAGING_ENABLED,
        given: opts.messaging,
        current: parseMessagingEnabled(env[EnvKey.L2PS_MESSAGING_ENABLED]),
        question: "Enable the instant-messaging server on top of L2PS?",
    })
    if (messaging) await collectPort(deps, wanted)
}

// ---------------------------------------------------------------------------
// ZK
// ---------------------------------------------------------------------------

async function zkSection(
    deps: WizardDeps,
    result: WizardResult,
    wantedEnv: Record<string, string>,
    state: { activeSubnets: Set<string> },
): Promise<void> {
    const { ctx, opts, prompter, say } = deps
    say("")
    say("ZK")

    const identity = inspectIdentityKey(ctx.root)
    if (identity.state === "ok") {
        say("  Identity proofs: ready (only the committed verification key is needed on a node).")
    } else {
        say(`  Identity proofs: ${identity.state.toUpperCase()} - ${identity.detail}`)
        say("  This key is shared by every validator and is never regenerated here.")
        say(`  ${IDENTITY_KEY_FIX}`)
        result.problems.push(`ZK identity verification key is ${identity.state}`)
    }

    const batches = inspectBatchArtifacts(ctx.root)
    const ready = batches.filter(b => b.complete).map(b => b.size)
    say(
        ready.length > 0
            ? `  L2PS batch proofs: keys ready for batches of up to ${ready.join(" and ")}.`
            : "  L2PS batch proofs: keys not built yet.",
    )

    const currentlyOn = parseBoolFlag(ctx.env[EnvKey.L2PS_ZK_ENABLED]) === true
    let want = opts.zk
    if (want === undefined && prompter) {
        if (state.activeSubnets.size === 0) {
            say("  No L2PS subnet is configured, so there are no batches to prove. Skipping.")
            return
        }
        want = await confirm(prompter, "Use ZK proofs for L2PS batches?", currentlyOn || ready.length > 0, say)
    }
    if (want === undefined) {
        say("  No ZK choice given (use --zk or --no-zk). Left as it is.")
        return
    }
    if (!want) {
        // Without an explicit choice, "off" is only worth writing when proofs
        // would otherwise be in use.
        if (opts.zk !== undefined || currentlyOn || ready.length > 0) {
            wantedEnv[EnvKey.L2PS_ZK_ENABLED] = "false"
        }
        say("  ZK proofs for L2PS batches: off.")
        return
    }
    if (state.activeSubnets.size === 0) {
        say("  No L2PS subnet is configured, so there are no batches to prove. Skipping.")
        return
    }

    // Requiring proofs before the keys exist would only make the node complain
    // at every start, so the switch is flipped last.
    const untouched = "  L2PS_ZK_ENABLED was left unchanged."
    if (batches.every(b => b.complete)) {
        say("  All batch keys are in place.")
        wantedEnv[EnvKey.L2PS_ZK_ENABLED] = "true"
        return
    }

    const tools = missingZkTools(ctx.root)
    if (tools.length > 0) {
        const msg = `Missing ${tools.join(", ")}. Run "bun install" first.`
        say(`  ${msg}`)
        say(untouched)
        result.problems.push(msg)
        return
    }

    const generate =
        opts.zkGenerate ??
        (prompter
            ? await confirm(
                  prompter,
                  "Build the batch proving keys now? (about 200 MB download, several minutes, around 2 GB of memory)",
                  true,
                  say,
              )
            : false)
    if (!generate) {
        say("  The batch keys are not built, and building them downloads about 200 MB.")
        say("  Build them with: bun run setup --only zk --zk --zk-generate")
        say(untouched)
        return
    }
    if (opts.dryRun) {
        say(`  would download two Powers of Tau files and build the missing keys under ${L2PS_ZK_DIR}/keys`)
        say("  would then set L2PS_ZK_ENABLED=true")
        return
    }

    const zkDir = path.join(ctx.root, L2PS_ZK_DIR)
    try {
        fs.accessSync(zkDir, fs.constants.W_OK)
    } catch {
        const msg = `${L2PS_ZK_DIR} is not writable here (read-only image?). Build the keys on a machine with a writable checkout.`
        say(`  ${msg}`)
        say(untouched)
        result.problems.push(msg)
        return
    }
    let built = false
    try {
        const outcome = await runL2psZkSetup(
            ctx.root,
            deps.runner,
            l => say(`  ${l}`),
            undefined,
            opts.ptauUrl ? [opts.ptauUrl] : undefined,
        )
        for (const m of outcome.messages) say(`  ${m}`)
        if (!outcome.ok) result.problems.push(...outcome.messages)
        built = outcome.ok
    } catch (e) {
        const msg = `Building the ZK keys failed: ${e instanceof Error ? e.message : e}`
        say(`  ${msg}`)
        result.problems.push(msg)
    }
    // A failed run never enables proofs, whatever files happen to be on disk.
    if (built && inspectBatchArtifacts(ctx.root).every(b => b.complete)) {
        wantedEnv[EnvKey.L2PS_ZK_ENABLED] = "true"
    } else {
        say(untouched)
    }
}

// ---------------------------------------------------------------------------
// env file
// ---------------------------------------------------------------------------

async function applyEnv(
    deps: WizardDeps,
    result: WizardResult,
    wanted: Record<string, string>,
): Promise<void> {
    const { ctx, opts, prompter, say } = deps
    if (Object.keys(wanted).length === 0) return

    const inFile = readEnvFile(ctx.envFilePath)
    const diff = diffEnv(inFile, wanted)
    const toApply: Record<string, string> = {}
    for (const c of diff.add) toApply[c.key] = c.to
    const applied: EnvChange[] = [...diff.add]

    for (const c of diff.conflict) {
        let replace = opts.force
        if (!replace && prompter && !opts.dryRun) {
            replace = await confirm(
                prompter,
                `${c.key} is ${c.from} in ${path.basename(ctx.envFilePath)}. Change it to ${c.to}?`,
                false,
                say,
            )
        }
        if (replace) {
            toApply[c.key] = c.to
            applied.push(c)
        } else {
            say(`  kept ${c.key}=${c.from} (wanted ${c.to}; pass --force to change it)`)
        }
    }
    for (const key of diff.same) say(`  unchanged ${key}`)

    const envName = path.basename(ctx.envFilePath)
    for (const c of applied) {
        const shadow = ctx.env[c.key]
        if (inFile[c.key] === undefined && shadow !== undefined && shadow !== c.to) {
            say(`  Note: ${c.key} is already set to ${shadow} outside ${envName}; that value wins until it is removed.`)
        }
    }
    if (applied.length === 0) return

    // Inside the image /app/.env is not the operator's file and would vanish
    // with the container, so the lines are handed over instead.
    if (ctx.inDocker && !opts.envFileGiven) {
        say(
            opts.dryRun
                ? "  Running inside the container image: .env would not be written; you would be given these lines for the host .env or the compose environment:"
                : "  Running inside the container image, so .env is not written. Put these lines in the host .env (or the compose environment) and recreate the container:",
        )
        for (const c of applied) {
            say(`    ${c.key}=${c.to}`)
            if (!opts.dryRun) result.manualEnv[c.key] = c.to
        }
        return
    }
    if (opts.dryRun) {
        for (const c of applied) say(`  would set ${c.key}=${c.to} in ${envName}`)
        return
    }

    const text = readTextIfExists(ctx.envFilePath) ?? ""
    let mode = 0o600
    try {
        mode = fs.statSync(ctx.envFilePath).mode & 0o777
    } catch {
        /* new file */
    }
    try {
        // Replacing the file by rename ignores its mode, so a file the owner
        // made read-only on purpose has to be checked by hand.
        const target = resolveSymlink(ctx.envFilePath)
        // A link inside the checkout that leads elsewhere is the operator's own
        // arrangement for that file, but the setup does not write outside the
        // checkout on the strength of a link; naming the file with --env-file
        // is how to say that is intended.
        const inCheckout = isInsideDir(path.dirname(ctx.envFilePath), ctx.root)
        if (inCheckout && !isInsideDir(target, ctx.root)) {
            throw new Error(`${envName} is a link to ${target}, outside the node directory; edit that file yourself or pass it with --env-file`)
        }
        if (fs.existsSync(target)) fs.accessSync(target, fs.constants.W_OK)
        writeFileGuarded(
            ctx.envFilePath,
            applyEnvChanges(text, toApply),
            { mode, overwrite: true, followSymlink: true, confineTo: inCheckout ? ctx.root : undefined },
            deps.now,
        )
        for (const c of applied) say(`  set ${c.key}=${c.to} in ${envName}`)
        result.envApplied.push(...applied)
        result.restartNeeded = true
    } catch (e) {
        // A container's /app is read-only; the operator copies the lines to the host .env.
        const why = e instanceof Error ? e.message : String(e)
        say(`  Could not write ${envName} (${why}). Add these lines to your .env by hand:`)
        result.problems.push(`${envName} could not be written (${why})`)
        for (const c of applied) {
            say(`    ${c.key}=${c.to}`)
            result.manualEnv[c.key] = c.to
        }
    }
}
