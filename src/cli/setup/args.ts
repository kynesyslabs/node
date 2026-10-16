import {
    parseBool,
    validateNonNegativeInt,
    validatePort,
    validateRpcList,
    validateRpcUrl,
    validateUid,
    type Result,
} from "./validate"

export class UsageError extends Error {}

export type Section = "l2ps" | "zk"

export interface SetupOptions {
    check: boolean
    json: boolean
    yes: boolean
    dryRun: boolean
    force: boolean
    help: boolean
    only?: Section
    envFile: string
    /** The operator named the file, so even a container may write it. */
    envFileGiven: boolean
    // L2PS answers
    l2ps?: boolean
    uid?: string
    role?: "create" | "join"
    rpcs?: string[]
    keyFile?: string
    ivFile?: string
    /** Hex key and IV for a join, taken from the environment only so they never show in `ps`. */
    keyHex?: string
    ivHex?: string
    retentionDays?: number
    storePlaintext?: boolean
    requireV2?: boolean
    messaging?: boolean
    messagingPort?: number
    // ZK answers
    zk?: boolean
    zkGenerate?: boolean
    ptauUrl?: string
}

type Kind = "bool" | "string" | "list"
interface Spec {
    flag: string
    key: keyof SetupOptions
    kind: Kind
    env?: string
}

// Booleans also accept --no-<flag>. Every answer has a flag and a
// DEMOS_SETUP_* variable so CI and docker can run without prompts.
const SPECS: Spec[] = [
    { flag: "check", key: "check", kind: "bool" },
    { flag: "json", key: "json", kind: "bool" },
    { flag: "yes", key: "yes", kind: "bool", env: "DEMOS_SETUP_YES" },
    { flag: "dry-run", key: "dryRun", kind: "bool", env: "DEMOS_SETUP_DRY_RUN" },
    { flag: "force", key: "force", kind: "bool", env: "DEMOS_SETUP_FORCE" },
    { flag: "help", key: "help", kind: "bool" },
    { flag: "only", key: "only", kind: "string", env: "DEMOS_SETUP_ONLY" },
    { flag: "env-file", key: "envFile", kind: "string", env: "DEMOS_SETUP_ENV_FILE" },
    { flag: "l2ps", key: "l2ps", kind: "bool", env: "DEMOS_SETUP_L2PS" },
    { flag: "l2ps-uid", key: "uid", kind: "string", env: "DEMOS_SETUP_L2PS_UID" },
    { flag: "l2ps-role", key: "role", kind: "string", env: "DEMOS_SETUP_L2PS_ROLE" },
    { flag: "l2ps-rpc", key: "rpcs", kind: "list", env: "DEMOS_SETUP_L2PS_RPC" },
    { flag: "l2ps-key-file", key: "keyFile", kind: "string", env: "DEMOS_SETUP_L2PS_KEY_FILE" },
    { flag: "l2ps-iv-file", key: "ivFile", kind: "string", env: "DEMOS_SETUP_L2PS_IV_FILE" },
    { flag: "history-retention-days", key: "retentionDays", kind: "string", env: "DEMOS_SETUP_HISTORY_RETENTION_DAYS" },
    { flag: "history-store-plaintext", key: "storePlaintext", kind: "bool", env: "DEMOS_SETUP_HISTORY_STORE_PLAINTEXT" },
    { flag: "history-require-v2", key: "requireV2", kind: "bool", env: "DEMOS_SETUP_HISTORY_REQUIRE_V2" },
    { flag: "messaging", key: "messaging", kind: "bool", env: "DEMOS_SETUP_MESSAGING" },
    { flag: "messaging-port", key: "messagingPort", kind: "string", env: "DEMOS_SETUP_MESSAGING_PORT" },
    { flag: "zk", key: "zk", kind: "bool", env: "DEMOS_SETUP_ZK" },
    { flag: "zk-generate", key: "zkGenerate", kind: "bool", env: "DEMOS_SETUP_ZK_GENERATE" },
    { flag: "ptau-url", key: "ptauUrl", kind: "string", env: "DEMOS_SETUP_PTAU_URL" },
]

/** Every DEMOS_SETUP_* variable the parser reads. */
export const SETUP_ENV_NAMES = SPECS.flatMap(s => (s.env ? [s.env] : []))

export const HELP = `Usage: bun run setup [options]

Sets up L2PS (private subnets) and ZK (proofs) for this node. Without flags it
asks questions; with --yes it uses the flags and DEMOS_SETUP_* variables only.

Modes
  --check                 Report what is configured, missing or invalid. Writes nothing,
                          so it cannot be combined with options that ask for a change.
  --json                  With --check, print the report as JSON.
  --dry-run               Show what would be written, change nothing.
  --yes, -y               Never ask; answer from flags and DEMOS_SETUP_* variables.
  --force                 Replace existing files and differing .env values
                          (the old file is kept as <name>.bak-<time>).
  --only l2ps|zk          Run just one part.

L2PS
  --l2ps / --no-l2ps      Set up L2PS on this node (implied by --l2ps-uid).
  --l2ps-uid <id>         Subnet id: letters, digits, _ and -, up to 255.
  --l2ps-role create|join create makes a new key; join imports the owner's key and IV.
  --l2ps-rpc <url>        RPC of a subnet member; repeat or comma-separate.
  --l2ps-key-file <path>  File holding the subnet key (hex) for join/import.
  --l2ps-iv-file <path>   File holding the subnet IV (hex) for join/import.
                          Or set DEMOS_SETUP_L2PS_KEY / DEMOS_SETUP_L2PS_IV.
  --history-retention-days <n>   Days to keep subnet history, 0 = forever.
  --history-store-plaintext      Also store decrypted message bodies (off by default).
  --history-require-v2           Refuse the old history signature.
  --messaging / --no-messaging   Instant-messaging server on top of L2PS.
  --messaging-port <port>        Messaging port (default 3006).

ZK
  --zk / --no-zk          Use ZK proofs for L2PS batches.
  --zk-generate           Build the missing proving keys (about 200 MB download, several minutes).
                          With --yes nothing is downloaded unless this is given; L2PS_ZK_ENABLED
                          is only switched on once the keys exist.
  --ptau-url <base>       Mirror of the Hermez Powers of Tau files, if the default hosts are down.

Other
  --env-file <path>       Env file to edit (default .env).

Exit codes
  0    done (or nothing to do), or --check found nothing wrong
  1    something is missing or could not be done: --check found a problem,
       a required answer is missing, a file or .env could not be written
  2    the command line or a DEMOS_SETUP_* value is invalid
  130  cancelled with Ctrl-C or end of input

Every value flag also reads DEMOS_SETUP_<FLAG NAME IN CAPS>, for example
DEMOS_SETUP_L2PS_UID. Flags win over variables.`

function coerceBool(name: string, raw: string): boolean {
    const b = parseBool(raw)
    if (b === undefined) throw new UsageError(`${name}: expected true or false, got "${raw}"`)
    return b
}

type RawAnswers = Partial<Record<keyof SetupOptions, string | string[] | boolean>>

/**
 * Reads the command line into raw answers. Strict mode throws at the first
 * mistake; lenient mode skips what it cannot read and keeps going, which lets a
 * caller learn which mode was asked for (--check --json) even when another
 * part of the line is wrong.
 */
function readFlags(argv: string[], lenient: boolean): { raw: RawAnswers; fromCli: Set<keyof SetupOptions> } {
    const raw: RawAnswers = {}
    const fromCli = new Set<keyof SetupOptions>()
    const bySpec = new Map<string, Spec>()
    for (const s of SPECS) bySpec.set(s.flag, s)
    const bad = (message: string): void => {
        if (!lenient) throw new UsageError(message)
    }

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (arg === "-y") {
            raw.yes = true
            fromCli.add("yes")
            continue
        }
        if (arg === "-h") {
            raw.help = true
            fromCli.add("help")
            continue
        }
        if (!arg.startsWith("--")) {
            // Position only: a secret passed here by mistake must not be printed back.
            bad(`Unexpected argument at position ${i + 1} (options start with --)`)
            continue
        }
        const eq = arg.indexOf("=")
        const name = arg.slice(2, eq === -1 ? undefined : eq)
        let inline = eq === -1 ? undefined : arg.slice(eq + 1)

        let spec = bySpec.get(name)
        let negated = false
        if (!spec && name.startsWith("no-")) {
            spec = bySpec.get(name.slice(3))
            negated = true
            if (spec?.kind !== "bool") spec = undefined
        }
        if (!spec) {
            bad(`Unknown option: --${name}`)
            continue
        }
        fromCli.add(spec.key)

        if (spec.kind === "bool") {
            if (inline === undefined && argv[i + 1] !== undefined && /^(true|false)$/i.test(argv[i + 1])) {
                inline = argv[++i]
            }
            const parsed = inline === undefined ? true : parseBool(inline)
            if (parsed === undefined) {
                bad(`--${name}: expected true or false, got "${inline}"`)
                continue
            }
            raw[spec.key] = negated ? !parsed : parsed
        } else {
            if (inline === undefined) {
                inline = argv[++i]
                if (inline === undefined || inline.startsWith("--")) {
                    bad(`--${name} needs a value`)
                    if (inline !== undefined) i--
                    continue
                }
            }
            if (spec.kind === "list") {
                const prev = (raw[spec.key] as string[] | undefined) ?? []
                raw[spec.key] = [...prev, inline]
            } else {
                raw[spec.key] = inline
            }
        }
    }
    return { raw, fromCli }
}

/** Which mode the command line asks for, even when the rest of it is wrong. */
export function peekModes(argv: string[]): { check: boolean; json: boolean; help: boolean } {
    const { raw } = readFlags(argv, true)
    return { check: raw.check === true, json: raw.json === true, help: raw.help === true }
}

type Source = Set<keyof SetupOptions>

/** Fills in what the command line left unset from DEMOS_SETUP_*; returns which answers came from the environment. */
function mergeEnvironment(raw: RawAnswers, env: Record<string, string | undefined>): Source {
    const fromEnv: Source = new Set()
    for (const s of SPECS) {
        if (raw[s.key] !== undefined || !s.env) continue
        const v = env[s.env]
        if (v === undefined || v === "") continue
        fromEnv.add(s.key)
        if (s.kind === "bool") raw[s.key] = coerceBool(s.env, v)
        else if (s.kind === "list") raw[s.key] = [v]
        else raw[s.key] = v
    }
    return fromEnv
}

/** The value of a validated answer, or a usage error naming the flag. */
function accepted<T>(flag: string, r: Result<T>): T {
    if (!r.ok) throw new UsageError(`--${flag}: ${r.error}`)
    return r.value
}

function oneOf<T extends string>(flag: string, value: string, allowed: readonly T[]): T {
    if (!allowed.includes(value as T)) {
        throw new UsageError(`--${flag} must be ${allowed.join(" or ")}, got "${value}"`)
    }
    return value as T
}

/** Turns the raw strings into typed, validated options. */
function buildOptions(raw: RawAnswers, env: Record<string, string | undefined>): SetupOptions {
    const o: SetupOptions = {
        check: raw.check === true,
        json: raw.json === true,
        yes: raw.yes === true,
        dryRun: raw.dryRun === true,
        force: raw.force === true,
        help: raw.help === true,
        envFile: (raw.envFile as string | undefined) ?? ".env",
        envFileGiven: raw.envFile !== undefined,
    }
    const bools = ["l2ps", "storePlaintext", "requireV2", "messaging", "zk", "zkGenerate"] as const
    for (const k of bools) if (raw[k] !== undefined) o[k] = raw[k] as boolean

    if (raw.only !== undefined) o.only = oneOf("only", raw.only as string, ["l2ps", "zk"] as const)
    if (raw.uid !== undefined) o.uid = accepted("l2ps-uid", validateUid(raw.uid as string))
    if (raw.role !== undefined) o.role = oneOf("l2ps-role", raw.role as string, ["create", "join"] as const)
    if (raw.rpcs !== undefined) o.rpcs = accepted("l2ps-rpc", validateRpcList(raw.rpcs as string[]))
    if (raw.ptauUrl !== undefined) o.ptauUrl = accepted("ptau-url", validateRpcUrl(raw.ptauUrl as string))
    if (raw.keyFile !== undefined) o.keyFile = raw.keyFile as string
    if (raw.ivFile !== undefined) o.ivFile = raw.ivFile as string
    // The key material only ever comes from the environment, never from argv.
    if (env.DEMOS_SETUP_L2PS_KEY) o.keyHex = env.DEMOS_SETUP_L2PS_KEY
    if (env.DEMOS_SETUP_L2PS_IV) o.ivHex = env.DEMOS_SETUP_L2PS_IV
    if (raw.retentionDays !== undefined) {
        o.retentionDays = accepted("history-retention-days", validateNonNegativeInt(raw.retentionDays as string))
    }
    if (raw.messagingPort !== undefined) {
        o.messagingPort = accepted("messaging-port", validatePort(raw.messagingPort as string))
    }
    return o
}

/** Answers that contradict each other, reported only within one source (flags win over variables, so a lingering variable never blocks a flag). */
function rejectContradictions(o: SetupOptions, fromCli: Source, fromEnv: Source): void {
    for (const source of [fromCli, fromEnv]) {
        const given = (...keys: Array<keyof SetupOptions>) => keys.some(k => source.has(k))
        if (source.has("l2ps") && o.l2ps === false && given("uid", "role", "rpcs", "keyFile", "ivFile")) {
            throw new UsageError("--no-l2ps cannot be combined with subnet answers such as --l2ps-uid")
        }
        const importsKey = given("keyFile", "ivFile") || (source === fromEnv && Boolean(o.keyHex || o.ivHex))
        if (o.role === "create" && source.has("role") && importsKey) {
            throw new UsageError("--l2ps-role create makes a new key; it cannot be combined with an imported key or IV (use --l2ps-role join)")
        }
    }
    if (o.only === "zk" && (o.l2ps !== undefined || o.uid !== undefined)) {
        throw new UsageError("--only zk cannot be combined with L2PS subnet options")
    }
}

/**
 * --check only reports. Anything that asks for a change next to it is a
 * contradiction the operator should hear about, not silently lose.
 */
function rejectCheckExtras(o: SetupOptions, fromCli: Source): void {
    if (!o.check && !fromCli.has("json")) return
    if (!o.check) throw new UsageError("--json only applies to --check")
    if (o.help) throw new UsageError("--help cannot be combined with --check")
    const allowed = new Set<keyof SetupOptions>(["check", "json", "envFile", "help"])
    const extra = [...fromCli].filter(k => !allowed.has(k))
    if (extra.length > 0) {
        const names = extra.map(k => `--${SPECS.find(sp => sp.key === k)?.flag ?? String(k)}`)
        throw new UsageError(`--check only reports and cannot be combined with ${names.join(", ")}`)
    }
}

export function parseSetupArgs(
    argv: string[],
    env: Record<string, string | undefined> = process.env,
): SetupOptions {
    const { raw, fromCli } = readFlags(argv, false)
    const fromEnv = mergeEnvironment(raw, env)
    const o = buildOptions(raw, env)
    rejectContradictions(o, fromCli, fromEnv)
    rejectCheckExtras(o, fromCli)
    return o
}
