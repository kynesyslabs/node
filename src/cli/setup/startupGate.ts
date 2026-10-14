/* eslint-disable no-console -- terminal tool: console is its output */
import {
    collectChecks,
    fixesFor,
    isFatal,
    isProblem,
    SETUP_COMMAND,
    type CheckItem,
} from "./checks"
import { createContext, detectDocker, isForegroundOnTerminal, type SetupContext } from "./context"
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
    cwd: string
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

/**
 * Runs before the node boots anything. A feature problem (L2PS, messaging,
 * ZK batch proofs) is announced loudly and the node keeps booting, because a
 * validator must not go down over an optional feature; DEMOS_SETUP_STRICT=true
 * turns that into a failed start for CI. A missing identity verification key
 * always stops the node, whatever the skip switch says. It never waits for input without a terminal, and it
 * never throws on an unreadable file.
 */
export async function enforceGuidedSetup(overrides: Partial<GateDeps> = {}): Promise<void> {
    const env = overrides.env ?? process.env
    const deps: GateDeps = {
        cwd: process.cwd(),
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
    const skip = parseBool(deps.env[SKIP_ENV]) === true
    // A mistyped safety switch must not read as "off" without a word: an
    // operator who wrote DEMOS_SETUP_STRICT=ture believes strict mode is on.
    for (const name of [STRICT_ENV, SKIP_ENV]) {
        const raw = deps.env[name]
        if (raw !== undefined && raw.trim() !== "" && parseBool(raw) === undefined) {
            deps.say(`${name}="${raw}" is not true or false; treating it as false.`)
        }
    }

    // Logging is a courtesy: a logger that fails must not decide whether the
    // node starts, so the banner on stderr stays the record.
    const record = async (message: string): Promise<void> => {
        try {
            await deps.logError(message)
        } catch {
            /* the banner on stderr already carries it */
        }
    }

    const inspect = (): CheckItem[] => {
        try {
            return collectChecks(createContext(deps.cwd, ".env", deps.env, deps.inDocker)).items
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
    const items = inspect()

    const fatal = items.filter(isFatal)
    if (fatal.length > 0) {
        const text = describeFatal(fatal)
        deps.say(text)
        await record(text)
        deps.exit(1)
    }

    // The skip switch silences the optional-feature report only.
    if (skip) return
    const problems = items.filter(i => isProblem(i) && !i.fatal)
    if (problems.length === 0) return

    const banner = describeProblems(problems, deps.inDocker)
    deps.say(banner)
    await record(banner)
    if (deps.strict) {
        deps.say(`${STRICT_ENV} is on: not starting.`)
        deps.exit(1)
    }
    if (!deps.interactive) return

    const prompter = deps.prompter ?? createReadlinePrompter()
    let restartNeeded = false
    let aborted = false
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
        } else {
            const ctx = createContext(deps.cwd, ".env", deps.env, deps.inDocker)
            const result = await runWizard({
                ctx,
                opts: parseSetupArgs([], {}),
                prompter,
                say: line => console.log(line),
                runner: createDefaultRunner(),
            })
            restartNeeded = result.restartNeeded
            const left = inspect().filter(i => isProblem(i) && !i.fatal)
            if (left.length > 0 && !restartNeeded) {
                deps.say("Still incomplete; booting anyway:")
                for (const p of left) deps.say(`  - ${p.area} / ${p.item}: ${p.detail}`)
            }
        }
    } catch (e) {
        if (e instanceof SetupTimedOut) {
            deps.say("\nNo answer in time; continuing without the setup.")
        } else if (e instanceof SetupAborted) {
            aborted = true
        } else {
            // A failed setup is not a reason to stop a node.
            deps.say(`Setup failed (${e instanceof Error ? e.message : String(e)}); booting anyway.`)
        }
    }
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
