import { HELP, parseSetupArgs, peekModes, UsageError } from "./args"
import {
    collectChecks,
    fixesFor,
    isProblem,
    renderTable,
    summarize,
    SETUP_COMMAND,
} from "./checks"
import { createContext } from "./context"
import { readEnvFileStrict } from "./envFile"
import { createReadlinePrompter, SetupAborted, type Prompter } from "./prompt"
import { createDefaultRunner } from "./runner"
import { runWizard, SetupError } from "./wizard"
import type { ZkRunner } from "./zk"

export interface CliDeps {
    cwd: string
    env: Record<string, string | undefined>
    isTTY: boolean
    say: (line: string) => void
    /** Replaces the terminal prompter; tests inject scripted answers here. */
    prompter?: Prompter
    runner?: ZkRunner
    /** Where the committed and built ZK keys are; defaults to cwd, main.ts passes the real checkout. */
    codeRoot?: string
    /** Override container detection; tests set it so they behave the same anywhere. */
    inDocker?: boolean
}

export function runCheck(deps: CliDeps, envFile: string, json: boolean): number {
    const ctx = createContext(deps.cwd, envFile, deps.env, deps.inDocker, deps.codeRoot)
    try {
        readEnvFileStrict(ctx.envFilePath)
    } catch (e) {
        throw new UsageError(`--env-file ${envFile} cannot be read (${e instanceof Error ? e.message : String(e)})`)
    }
    const report = collectChecks(ctx)
    const problems = report.items.filter(isProblem)
    if (json) {
        deps.say(JSON.stringify({ ok: problems.length === 0, items: report.items }, null, 2))
    } else {
        deps.say(renderTable(report.items))
        deps.say("")
        deps.say(summarize(report.items))
        const fixes = fixesFor(report.items)
        if (fixes.length > 0) deps.say(`To fix: ${fixes.join("  |  ")}`)
        else if (problems.length === 0) deps.say("Nothing to fix.")
    }
    return problems.length === 0 ? 0 : 1
}

/** A script reading --check --json gets a document on every path, errors included. */
function jsonFailure(deps: CliDeps, message: string): void {
    deps.say(JSON.stringify({ ok: false, error: message, items: [] }, null, 2))
}

/** Returns the process exit code. */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
    const modes = peekModes(argv)
    const wantsJson = modes.check && modes.json
    try {
        const opts = parseSetupArgs(argv, deps.env)
        if (opts.help) {
            deps.say(HELP)
            return 0
        }
        if (opts.check) return runCheck(deps, opts.envFile, opts.json)

        // Never wait for input without a terminal, and --yes never asks.
        const interactive = !opts.yes && deps.isTTY
        const prompter = interactive
            ? (deps.prompter ?? createReadlinePrompter())
            : undefined
        if (!interactive && !opts.yes) {
            deps.say("No terminal detected: using flags and DEMOS_SETUP_* variables only, no questions will be asked.")
        }
        const result = await runWizard({
            ctx: createContext(deps.cwd, opts.envFile, deps.env, deps.inDocker, deps.codeRoot),
            opts,
            prompter,
            say: deps.say,
            runner: deps.runner ?? createDefaultRunner(),
        })
        return result.exitCode
    } catch (e) {
        if (e instanceof UsageError) {
            if (wantsJson) jsonFailure(deps, e.message)
            else deps.say(`${e.message}\nSee: ${SETUP_COMMAND} --help`)
            return 2
        }
        if (wantsJson) {
            jsonFailure(deps, e instanceof Error ? e.message : String(e))
            return 1
        }
        if (e instanceof SetupError) {
            deps.say(e.message)
            return 1
        }
        if (e instanceof SetupAborted) {
            deps.say("\nSetup cancelled. Nothing further was changed.")
            return 130
        }
        throw e
    }
}
