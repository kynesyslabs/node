import * as fs from "node:fs"
import * as path from "node:path"
import { EnvKey } from "../../config/envKeys"
import type { SetupOptions } from "./args"
import {
    collectChecks,
    fixesFor,
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
import { readTextIfExists, writeFileGuarded, type WriteOutcome } from "./files"
import {
    buildSubnetFiles,
    generateKeyMaterial,
    inspectSubnet,
    inspectSubnets,
    sameJson,
} from "./l2ps"
import { ask, confirm, select, type Prompter } from "./prompt"
import {
    validateIvHex,
    validateKeyHex,
    validateNonNegativeInt,
    validatePort,
    validateRpcList,
    validateUid,
    parseBool,
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
    }
    if (opts.only !== "l2ps") {
        await zkSection(deps, result, wantedEnv, state)
    }
    await applyEnv(deps, result, wantedEnv)

    say("")
    if (opts.dryRun) {
        say("Dry run finished. Run again without --dry-run to apply.")
    } else {
        // Same precedence the node applies: the real environment over the env file.
        const report = collectChecks({
            ...deps.ctx,
            env: { ...readEnvFile(deps.ctx.envFilePath), ...deps.ctx.processEnv },
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

function readSecretFile(file: string, label: string): string {
    try {
        return fs.readFileSync(file, "utf8")
    } catch (e) {
        throw new SetupError(`Cannot read ${label} file ${file}: ${e instanceof Error ? e.message : e}`)
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

    let enable = opts.l2ps ?? (opts.uid !== undefined ? true : undefined)
    if (enable === undefined) {
        if (!prompter) {
            say("  Nothing requested (use --l2ps-uid <id> to set up a subnet). Left as it is.")
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
        say("  L2PS left as it is.")
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

    const dir = path.join(ctx.root, "data", "l2ps", uid)
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
            : fallback
    }

    await collectL2psEnv(deps, wantedEnv)

    // Reuse what is already on disk before generating anything new.
    const keyPath = path.join(dir, "private_key.txt")
    const ivPath = path.join(dir, "iv.txt")
    const onDiskKey = readTextIfExists(keyPath)
    const onDiskIv = readTextIfExists(ivPath)
    const reuseKey = onDiskKey !== undefined && validateKeyHex(onDiskKey).ok ? onDiskKey.trim() : undefined
    const reuseIv = onDiskIv !== undefined && validateIvHex(onDiskIv).ok ? onDiskIv.trim() : undefined
    const generated = opts.dryRun
        ? { keyHex: "<new random key>", ivHex: "<new random iv>" }
        : generateKeyMaterial(deps.randomBytes)
    const files = buildSubnetFiles({
        uid,
        rpcs,
        keyHex: importedKey ?? reuseKey ?? generated.keyHex,
        ivHex: importedIv ?? reuseIv ?? generated.ivHex,
        existingConfig,
    })

    for (const f of files) {
        const abs = path.join(ctx.root, f.rel)
        const current = readTextIfExists(abs)
        const differs =
            current !== undefined &&
            (f.rel.endsWith(".json") ? !sameJson(current, f.content) : current !== f.content)
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
        if (opts.dryRun) {
            const outcome =
                current === undefined ? "would-create" : !differs ? "would-keep" : overwrite ? "would-replace" : "would-keep"
            result.files.push({ rel: f.rel, outcome })
            say(`  ${outcome.replace("-", " ")}: ${f.rel}${f.secret ? " (mode 600, contents never shown)" : ""}`)
            continue
        }
        if (current !== undefined && !differs && current !== f.content) {
            // Same data, different layout: leave the operator's file as written.
            result.files.push({ rel: f.rel, outcome: "unchanged" })
            say(`  unchanged ${f.rel}`)
            continue
        }
        const outcome = writeFileGuarded(abs, f.content, { mode: f.mode, overwrite }, deps.now)
        result.files.push({
            rel: f.rel,
            outcome: outcome.status,
            backup: outcome.status === "replaced" ? outcome.backup : undefined,
        })
        say(describe(f.rel, outcome, f.secret, differs && !overwrite))
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
    const raw = hex ?? (file !== undefined ? readSecretFile(file, label) : undefined)
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

async function collectL2psEnv(deps: WizardDeps, wanted: Record<string, string>): Promise<void> {
    const { opts, prompter, ctx, say } = deps
    const env = ctx.env
    const num = (r: Result<number>) => (r.ok ? r.value : undefined)

    let retention = opts.retentionDays
    if (retention === undefined && prompter) {
        const v = await ask(prompter, "Days to keep subnet history (0 keeps it forever)", {
            default: env[EnvKey.L2PS_HISTORY_RETENTION_DAYS] ?? "0",
            validate: x => {
                const r = validateNonNegativeInt(x)
                return r.ok ? null : r.error
            },
            say,
        })
        retention = num(validateNonNegativeInt(v))
    }
    if (retention !== undefined) wanted[EnvKey.L2PS_HISTORY_RETENTION_DAYS] = String(retention)

    let plaintext = opts.storePlaintext
    if (plaintext === undefined && prompter) {
        plaintext = await confirm(
            prompter,
            "Also store decrypted message bodies in the database? (not recommended)",
            parseBool(env[EnvKey.L2PS_HISTORY_STORE_PLAINTEXT]) ?? false,
            say,
        )
        if (plaintext && !(await confirm(prompter, "Message bodies will be readable by anyone with database access. Keep this on?", false, say))) {
            plaintext = false
        }
    }
    if (plaintext !== undefined) wanted[EnvKey.L2PS_HISTORY_STORE_PLAINTEXT] = String(plaintext)

    let requireV2 = opts.requireV2
    if (requireV2 === undefined && prompter) {
        requireV2 = await confirm(
            prompter,
            "Refuse the old history signature? (turn on only once clients sign the new form)",
            parseBool(env[EnvKey.L2PS_HISTORY_REQUIRE_V2]) ?? false,
            say,
        )
    }
    if (requireV2 !== undefined) wanted[EnvKey.L2PS_HISTORY_REQUIRE_V2] = String(requireV2)

    let messaging = opts.messaging
    if (messaging === undefined && prompter) {
        messaging = await confirm(
            prompter,
            "Enable the instant-messaging server on top of L2PS?",
            parseBool(env[EnvKey.L2PS_MESSAGING_ENABLED]) ?? false,
            say,
        )
    }
    if (messaging !== undefined) wanted[EnvKey.L2PS_MESSAGING_ENABLED] = String(messaging)
    if (messaging) {
        let port = opts.messagingPort
        if (port === undefined && prompter) {
            const v = await ask(prompter, "Messaging port", {
                default: env[EnvKey.L2PS_MESSAGING_PORT] ?? "3006",
                validate: x => {
                    const r = validatePort(x)
                    return r.ok ? null : r.error
                },
                say,
            })
            port = num(validatePort(v))
        }
        if (port !== undefined) wanted[EnvKey.L2PS_MESSAGING_PORT] = String(port)
    }
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
        say("  This key is shared by every validator and is never regenerated here. Restore it with:")
        say("    git checkout -- src/features/zk/keys/verification_key_merkle.json")
        result.problems.push(`ZK identity verification key is ${identity.state}`)
    }

    const batches = inspectBatchArtifacts(ctx.root)
    const ready = batches.filter(b => b.complete).map(b => b.size)
    say(
        ready.length > 0
            ? `  L2PS batch proofs: keys ready for batches of up to ${ready.join(" and ")}.`
            : "  L2PS batch proofs: keys not built yet.",
    )

    const currentlyOn = parseBool(ctx.env[EnvKey.L2PS_ZK_ENABLED]) === true
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
        wantedEnv[EnvKey.L2PS_ZK_ENABLED] = "false"
        say("  ZK proofs for L2PS batches: off.")
        return
    }
    if (state.activeSubnets.size === 0) {
        say("  No L2PS subnet is configured, so there are no batches to prove. Skipping.")
        return
    }
    wantedEnv[EnvKey.L2PS_ZK_ENABLED] = "true"
    if (batches.every(b => b.complete)) {
        say("  All batch keys are in place.")
        return
    }

    const tools = missingZkTools(ctx.root)
    if (tools.length > 0) {
        const msg = `Missing ${tools.join(", ")}. Run "bun install" first.`
        say(`  ${msg}`)
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
            : true)
    if (!generate) {
        say("  Not building. Later: bun run setup --only zk --zk --zk-generate")
        return
    }
    if (opts.dryRun) {
        say(`  would download two Powers of Tau files and build the missing keys under ${L2PS_ZK_DIR}/keys`)
        return
    }

    const zkDir = path.join(ctx.root, L2PS_ZK_DIR)
    try {
        fs.accessSync(zkDir, fs.constants.W_OK)
    } catch {
        const msg = `${L2PS_ZK_DIR} is not writable here (read-only image?). Build the keys on a machine with a writable checkout.`
        say(`  ${msg}`)
        result.problems.push(msg)
        return
    }
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
    } catch (e) {
        const msg = `Building the ZK keys failed: ${e instanceof Error ? e.message : e}`
        say(`  ${msg}`)
        result.problems.push(msg)
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
        writeFileGuarded(ctx.envFilePath, applyEnvChanges(text, toApply), { mode, overwrite: true }, deps.now)
        for (const c of applied) say(`  set ${c.key}=${c.to} in ${envName}`)
        result.envApplied.push(...applied)
        result.restartNeeded = true
    } catch (e) {
        // A container's /app is read-only; the operator copies the lines to the host .env.
        say(`  Could not write ${envName} (${e instanceof Error ? e.message : e}). Add these lines to your .env by hand:`)
        for (const c of applied) {
            say(`    ${c.key}=${c.to}`)
            result.manualEnv[c.key] = c.to
        }
    }
}
