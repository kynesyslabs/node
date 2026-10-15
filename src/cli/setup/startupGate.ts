/* eslint-disable no-console -- terminal tool: console is its output */
import {
    collectChecks,
    fixesFor,
    isFatal,
    isProblem,
    SETUP_COMMAND,
    type CheckItem,
} from "./checks"
import { CODE_ROOT, createContext, detectDocker, isForegroundOnTerminal, type SetupContext } from "./context"
import {
    confirm,
    createReadlinePrompter,
    SetupAborted,
    SetupTimedOut,
    type Prompter,
} from "./prompt"
import { createDefaultRunner } from "./runner"
import { parseBool } from "./validate"
import { runWizard } from "./wizard"
import { parseSetupArgs } from "./args"

export const SKIP_ENV = "DEMOS_SKIP_SETUP_CHECK"
export const STRICT_ENV = "DEMOS_SETUP_STRICT"
const OFFER_TIMEOUT_MS = 30_000
const RULE = "=".repeat(72)

export interface GateDeps {
    /** The operator's node directory: .env and data/ are read from here, as the node does. */
    cwd: string
    /** The checkout this code lives in: where the committed and built ZK keys are. */
    codeRoot: string
    env: Record<string, string | undefined>
    interactive: boolean
    say: (line: string) => void
    /** Also records the problems in the node log. */
    logError: (message: string) => void | Promise<void>
    prompter?: Prompter
    inDocker: boolean
    /** Stop the node on any problem, not only on the consensus-critical one. */
    strict: boolean
    offerTimeoutMs: number
    exit: (code: number) => never
}

export function startupProblems(ctx: SetupContext): CheckItem[] {
    return collectChecks(ctx).items.filter(isProblem)
}

export function describeProblems(problems: CheckItem[], inDocker: boolean): string {
    const fixes = fixesFor(problems)
    const runIn = inDocker ? "docker compose exec node " : ""
    return [
        RULE,
        " DEMOS NODE SETUP WARNING",
        " L2PS or ZK is configured on this node, but its setup is incomplete:",
        ...problems.map(p => `   - ${p.area} / ${p.item}: ${p.detail}`),
        "",
        " The node keeps booting; the affected features stay unavailable.",
        ` Fix it:   ${runIn}${fixes.length > 0 ? fixes.join("  |  ") : SETUP_COMMAND}`,
        ` Inspect:  ${runIn}${SETUP_COMMAND} --check`,
        ` Fail fast instead of booting:  ${STRICT_ENV}=true`,
        ` Silence this check:            ${SKIP_ENV}=true`,
        RULE,
    ].join("\n")
}

/** The one problem that stops every start: it is consensus-critical. */
export function describeFatal(fatal: CheckItem[]): string {
    return [
        RULE,
        " DEMOS NODE CANNOT START: ZK identity verification key",
        ...fatal.map(p => `   - ${p.detail}`),
        "",
        " Every validator must verify identity proofs with the same committed key,",
        " so the node does not start without it.",
        ` Fix: ${fatal[0]?.fix ?? "restore the committed key from the repository"}`,
        RULE,
    ].join("\n")
}

async function defaultLogError(message: string): Promise<void> {
    try {
        const { default: log } = await import("@/utilities/logger")
        log.error(`[SETUP] ${message}`)
    } catch {
        /* the banner on stderr already carries it */
    }
}

function buildDeps(overrides: Partial<GateDeps>): GateDeps {
    const env = overrides.env ?? process.env
    return {
        cwd: process.cwd(),
        codeRoot: CODE_ROOT,
        env,
        interactive:
            Boolean(process.stdin.isTTY && process.stdout.isTTY) &&
            parseBool(env.CI) !== true &&
            isForegroundOnTerminal(),
        say: line => console.error(line),
        logError: defaultLogError,
        inDocker: detectDocker(env),
        strict: parseBool(env[STRICT_ENV]) === true,
        offerTimeoutMs: OFFER_TIMEOUT_MS,
        exit: code => process.exit(code),
        ...overrides,
    }
}

/**
 * A mistyped safety switch must not read as "off" without a word: an operator
 * who wrote DEMOS_SETUP_STRICT=ture believes strict mode is on.
 */
function warnAboutMistypedSwitches(deps: GateDeps): void {
    for (const name of [STRICT_ENV, SKIP_ENV]) {
        const raw = deps.env[name]
        if (raw !== undefined && raw.trim() !== "" && parseBool(raw) === undefined) {
            deps.say(`${name}="${raw}" is not true or false; treating it as false.`)
        }
    }
}

/**
 * Logging is a courtesy: a logger that fails must not decide whether the node
 * starts, so the banner on stderr stays the record.
 */
function safeRecorder(deps: GateDeps): (message: string) => Promise<void> {
    return async message => {
        try {
            await deps.logError(message)
        } catch {
            /* the banner on stderr already carries it */
        }
    }
}

function inspectSetup(deps: GateDeps): CheckItem[] {
    try {
        return collectChecks(createContext(deps.cwd, ".env", deps.env, deps.inDocker, deps.codeRoot)).items
    } catch (e) {
        return [
            {
                area: "Setup",
                item: "Inspection",
                status: "invalid",
                detail: `could not be checked (${e instanceof Error ? e.message : String(e)})`,
                blocking: true,
            },
        ]
    }
}

const featureProblems = (items: CheckItem[]): CheckItem[] => items.filter(i => isProblem(i) && !i.fatal)

interface OfferOutcome {
    restartNeeded: boolean
    aborted: boolean
}

/** Asks whether to run the setup now and, on yes, runs it. Never throws: every way it can end is an outcome. */
async function offerSetup(deps: GateDeps): Promise<OfferOutcome> {
    const prompter = deps.prompter ?? createReadlinePrompter()
    try {
        deps.say("")
        const seconds = Math.round(deps.offerTimeoutMs / 1000)
        const yes = await confirm(
            prompter,
            `Run the setup now? (no answer in ${seconds}s continues booting)`,
            false,
            deps.say,
            deps.offerTimeoutMs,
        )
        if (!yes) {
            deps.say("Continuing without the setup.")
            return { restartNeeded: false, aborted: false }
        }
        const result = await runWizard({
            ctx: createContext(deps.cwd, ".env", deps.env, deps.inDocker, deps.codeRoot),
            opts: parseSetupArgs([], {}),
            prompter,
            say: line => console.log(line),
            runner: createDefaultRunner(),
        })
        const left = featureProblems(inspectSetup(deps))
        if (left.length > 0 && !result.restartNeeded) {
            deps.say("Still incomplete; booting anyway:")
            for (const p of left) deps.say(`  - ${p.area} / ${p.item}: ${p.detail}`)
        }
        return { restartNeeded: result.restartNeeded, aborted: false }
    } catch (e) {
        if (e instanceof SetupAborted) return { restartNeeded: false, aborted: true }
        if (e instanceof SetupTimedOut) {
            deps.say("\nNo answer in time; continuing without the setup.")
        } else {
            // A failed setup is not a reason to stop a node.
            deps.say(`Setup failed (${e instanceof Error ? e.message : String(e)}); booting anyway.`)
        }
        return { restartNeeded: false, aborted: false }
    }
}

/**
 * Runs before the node boots anything. A feature problem (L2PS, messaging,
 * ZK batch proofs) is announced loudly and the node keeps booting, because a
 * validator must not go down over an optional feature; DEMOS_SETUP_STRICT=true
 * turns that into a failed start for CI. A missing identity verification key
 * always stops the node, whatever the skip switch says. It never waits for
 * input without a terminal, and it never throws on an unreadable file.
 */
export async function enforceGuidedSetup(overrides: Partial<GateDeps> = {}): Promise<void> {
    const deps = buildDeps(overrides)
    warnAboutMistypedSwitches(deps)
    const record = safeRecorder(deps)
    const items = inspectSetup(deps)

    const fatal = items.filter(isFatal)
    if (fatal.length > 0) {
        const text = describeFatal(fatal)
        deps.say(text)
        await record(text)
        deps.exit(1)
    }

    // The skip switch silences the optional-feature report only.
    const problems = featureProblems(items)
    if (parseBool(deps.env[SKIP_ENV]) === true || problems.length === 0) return

    const banner = describeProblems(problems, deps.inDocker)
    deps.say(banner)
    await record(banner)
    if (deps.strict) {
        deps.say(`${STRICT_ENV} is on: not starting.`)
        deps.exit(1)
    }
    if (!deps.interactive) return

    const { restartNeeded, aborted } = await offerSetup(deps)
    if (aborted) {
        deps.say("\nAborted by the operator; the node was not started.")
        deps.exit(130)
    }
    if (restartNeeded) {
        // Config and the env-derived state are read once at import.
        deps.say("Setup changed the env file. Start the node again to use it.")
        deps.exit(0)
    }
}
