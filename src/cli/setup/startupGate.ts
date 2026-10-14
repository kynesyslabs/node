/* eslint-disable no-console -- terminal tool: console is its output */
import * as fs from "node:fs"
import {
    collectChecks,
    fixesFor,
    isProblem,
    SETUP_COMMAND,
    type CheckItem,
} from "./checks"
import { createContext, type SetupContext } from "./context"
import { confirm, createReadlinePrompter, SetupAborted, type Prompter } from "./prompt"
import { createDefaultRunner } from "./runner"
import { parseBool } from "./validate"
import { runWizard } from "./wizard"
import { parseSetupArgs } from "./args"

export const SKIP_ENV = "DEMOS_SKIP_SETUP_CHECK"

export interface GateDeps {
    cwd: string
    env: Record<string, string | undefined>
    interactive: boolean
    say: (line: string) => void
    prompter?: Prompter
    inDocker: boolean
    exit: (code: number) => never
}

export function startupProblems(ctx: SetupContext): CheckItem[] {
    return collectChecks(ctx).items.filter(isProblem)
}

export function describeProblems(problems: CheckItem[], inDocker: boolean): string {
    const fixes = fixesFor(problems)
    const runIn = inDocker ? "docker compose exec node " : ""
    return [
        "L2PS or ZK is configured on this node, but its setup is incomplete:",
        ...problems.map(p => `  - ${p.area} / ${p.item}: ${p.detail}`),
        "",
        `Fix it:     ${runIn}${fixes.length > 0 ? fixes.join("  |  ") : SETUP_COMMAND}`,
        `Inspect:    ${runIn}${SETUP_COMMAND} --check`,
        `Start anyway (the affected features stay unavailable): ${SKIP_ENV}=true`,
    ].join("\n")
}

/**
 * Runs before the node boots anything. With a terminal it offers the setup
 * inline; without one (docker, systemd, CI) it stops with a single message,
 * and it never waits for input.
 */
export async function enforceGuidedSetup(overrides: Partial<GateDeps> = {}): Promise<void> {
    const deps: GateDeps = {
        cwd: process.cwd(),
        env: process.env,
        interactive:
            Boolean(process.stdin.isTTY && process.stdout.isTTY) &&
            parseBool(process.env.CI) !== true,
        say: line => console.error(line),
        inDocker: fs.existsSync("/.dockerenv"),
        exit: code => process.exit(code),
        ...overrides,
    }
    if (parseBool(deps.env[SKIP_ENV]) === true) return

    const ctx = createContext(deps.cwd, ".env", deps.env)
    const problems = startupProblems(ctx)
    if (problems.length === 0) return

    deps.say(describeProblems(problems, deps.inDocker))
    if (!deps.interactive) deps.exit(1)

    const prompter = deps.prompter ?? createReadlinePrompter()
    try {
        deps.say("")
        if (!(await confirm(prompter, "Run the setup now?", true, deps.say))) {
            deps.say("Continuing without it.")
            return
        }
        const result = await runWizard({
            ctx,
            opts: parseSetupArgs([], {}),
            prompter,
            say: line => console.log(line),
            runner: createDefaultRunner(),
        })
        if (result.restartNeeded) {
            // Config and the env-derived state are read once at import.
            deps.say("Setup changed the env file. Start the node again to use it.")
            deps.exit(0)
        }
        const left = startupProblems(createContext(deps.cwd, ".env", deps.env))
        if (left.length > 0) {
            deps.say("Still incomplete; starting anyway:")
            for (const p of left) deps.say(`  - ${p.area} / ${p.item}: ${p.detail}`)
        }
    } catch (e) {
        if (e instanceof SetupAborted) {
            deps.say("Setup cancelled; continuing with the current configuration.")
            return
        }
        throw e
    }
}
